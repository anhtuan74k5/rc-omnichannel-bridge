const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createMock } = require('../scripts/e2e/mock-platforms');

const mock = createMock();
const mappingFile = path.join(os.tmpdir(), `zalo-mapping-${process.pid}.json`);
let base;
let origin;
let server;
let mapping;
let rocketchat;
let zalo;
let queue;
let deliverAgentMessages;
const room = [];
let files;

test.before(async () => {
  const port = await mock.listen(0);
  origin = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    MAPPING_FILE: mappingFile,
    AI_ENABLED: 'false',
    ZALO_ENABLED: 'true',
    ZALO_APP_ID: 'app-1',
    ZALO_OA_SECRET_KEY: 'oa-secret',
    ZALO_ACCESS_TOKEN: 'zalo-token',
    ZALO_API_BASE_URL: origin,
    ZALO_MEDIA_HOSTS: `.zdn.vn,${origin}`,
  });
  mapping = require('../src/core/mapping');
  rocketchat = require('../src/rocketchat/rocketchat');
  zalo = require('../src/platforms/zalo');
  files = require('../src/media/rocketchatFiles');
  const bridge = require('..');
  queue = bridge.facebookQueue;
  deliverAgentMessages = bridge.deliverAgentMessages;
  mapping.load();
  Object.assign(rocketchat, {
    getOrCreateVisitor: async () => 'visitor_zalo',
    getOrCreateRoom: async () => 'zalo-room',
    sendMessageToRocketChat: async (token, roomId, text) => room.push(text),
    uploadLivechatFile: async (token, roomId, file) => room.push(`file:${file.filename}`),
  });
  server = http.createServer(bridge.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/webhook/zalo`;
});

test.after(async () => {
  server.close();
  await mock.close();
  try { fs.unlinkSync(mappingFile); } catch { /* already gone */ }
});

test.beforeEach(() => { mock.clear(); room.length = 0; });

function post(event, { secret = 'oa-secret' } = {}) {
  const payload = { app_id: 'app-1', timestamp: String(Date.now()), ...event };
  const body = JSON.stringify(payload);
  const mac = crypto.createHash('sha256').update(`app-1${body}${payload.timestamp}${secret}`).digest('hex');
  return fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-zevent-signature': `mac=${mac}` },
    body,
  });
}

const textEvent = (id, text) => ({
  event_name: 'user_send_text', sender: { id: 'u1' }, message: { msg_id: id, text },
});

test('a signed text reaches the room once, even when redelivered', async () => {
  assert.equal((await post(textEvent('m1', 'xin chào'))).status, 200);
  await queue.idle(5000);
  assert.equal((await post(textEvent('m1', 'xin chào'))).status, 200);
  await queue.idle(5000);
  assert.deepEqual(room, ['xin chào']);
});

test('a wrong signature is rejected', async () => {
  assert.equal((await post(textEvent('m2', 'giả'), { secret: 'guess' })).status, 401);
  await queue.idle(5000);
  assert.deepEqual(room, []);
});

test('an image is uploaded; a foreign host is refused without being fetched', async () => {
  await post({
    event_name: 'user_send_image', sender: { id: 'u1' },
    message: { msg_id: 'm3', attachments: [{ type: 'image', payload: { url: `${origin}/zalo-media/a.png` } }] },
  });
  await queue.idle(5000);
  assert.deepEqual(room, ['file:a.png']);

  room.length = 0;
  await post({
    event_name: 'user_send_file', sender: { id: 'u1' },
    message: { msg_id: 'm4', attachments: [{ type: 'file', payload: { url: 'http://169.254.169.254/x' } }] },
  });
  await queue.idle(5000);
  assert.equal(room.length, 1);
  assert.match(room[0], /ZALO_MEDIA_URL_REJECTED/);
});

test('a location becomes a map link', async () => {
  await post({
    event_name: 'user_send_location', sender: { id: 'u1' },
    message: { msg_id: 'm5', attachments: [{ type: 'location', payload: { coordinates: { latitude: '21.03', longitude: '105.78' } } }] },
  });
  await queue.idle(5000);
  assert.match(room[0], /maps\?q=21\.03,105\.78/);
});

function agentEntry(id) {
  const entry = mapping.getOrCreate('zalo', id);
  mapping.update(entry, { visitorToken: `visitor_${id}`, roomId: `room-${id}` });
  return entry;
}

const message = (id, fields) => ({ _id: id, ts: new Date().toISOString(), msg: '', ...fields });

test('agent text and files are sent through the OA API', async (t) => {
  const original = files.downloadRocketChatFile;
  t.after(() => { files.downloadRocketChatFile = original; });
  await deliverAgentMessages(agentEntry('u2'), [message('a1', { msg: '*chào* bạn' })]);
  const sent = JSON.parse(mock.requests[0].json);
  assert.equal(mock.requests[0].route, 'oa/message/cs');
  assert.deepEqual(sent, { recipient: { user_id: 'u2' }, message: { text: 'chào bạn' } });

  mock.clear();
  await zalo.sendMedia('u2', { buffer: Buffer.from('x'), filename: 'a.pdf' });
  assert.deepEqual(mock.requests.map((r) => r.route), ['oa/upload/file', 'oa/message/cs']);
  await assert.rejects(zalo.sendMedia('u2', { buffer: Buffer.from('x'), filename: 'a.zip' }), /ZALO_MEDIA_UNSUPPORTED/);
});

for (const [fault, kind, attempts] of [['zalo-230', 'permanent', 1], ['zalo-213', 'permanent', 1], ['zalo-32', 'transient', 3], ['zalo-216', 'auth', 3]]) {
  test(`${fault} is ${kind}: the agent is told after ${attempts} attempt(s)`, async () => {
    const { classifyDeliveryError } = require('../src/core/deliveryErrors');
    mock.inject('zalo', fault, 1);
    const error = await zalo.sendMessage('u3', 'x').catch((err) => err);
    assert.equal(classifyDeliveryError('zalo', error).kind, kind);

    mock.clear();
    mock.inject('zalo', fault, 0);
    const entry = agentEntry(`u-${fault}`);
    for (let i = 0; i < attempts; i += 1) {
      await deliverAgentMessages(entry, [message(`f-${fault}`, { msg: 'trả lời' })]);
    }
    assert.equal(room.filter((line) => line.includes('Không gửi được')).length, 1);
  });
}
