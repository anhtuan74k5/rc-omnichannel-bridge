const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate from the developer's real .env and mapping.json.
const mappingFile = path.join(os.tmpdir(), `media-pipeline-mapping-${process.pid}.json`);
process.env.MAPPING_FILE = mappingFile;
process.env.AI_ENABLED = 'false';

const rocketchat = require('../rocketchat');
const { relayMediaToRocketChat } = require('../src/inbound/mediaPipeline');

test.after(() => { try { fs.unlinkSync(mappingFile); } catch { /* already gone */ } });

function setup(t) {
  const calls = { upload: [], room: [], notices: [] };
  const originals = {};
  for (const name of ['getOrCreateVisitor', 'getOrCreateRoom', 'uploadLivechatFile', 'sendMessageToRocketChat']) {
    originals[name] = rocketchat[name];
  }
  rocketchat.getOrCreateVisitor = async () => 'visitor-token';
  rocketchat.getOrCreateRoom = async () => 'room-1';
  rocketchat.uploadLivechatFile = async (token, roomId, file) => { calls.upload.push({ token, roomId, file }); };
  rocketchat.sendMessageToRocketChat = async (token, roomId, text) => { calls.room.push(text); };
  t.after(() => Object.assign(rocketchat, originals));
  return calls;
}

const base = (calls, overrides) => ({
  platform: 'telegram',
  userId: 'pipe-1',
  roomName: 'TG pipe-1',
  type: 'photo',
  origin: 'from chat pipe-1',
  filename: 'initial.jpg',
  download: async () => ({ buffer: Buffer.from('x'), filename: 'real.jpg', mimeType: 'image/jpeg' }),
  isTooLarge: (err) => err.code === 'big',
  sendNotice: async (text) => { calls.notices.push(text); },
  notices: { tooLarge: 'TOO_LARGE', failed: 'FAILED' },
  statusMessage: (filename, reason) => `status ${filename}: ${reason}`,
  ...overrides,
});

test('uploads the downloaded file and runs afterUpload', async (t) => {
  const calls = setup(t);
  let after = 0;
  await relayMediaToRocketChat(base(calls, { afterUpload: async () => { after += 1; } }));
  assert.equal(calls.upload.length, 1);
  assert.equal(calls.upload[0].roomId, 'room-1');
  assert.equal(calls.upload[0].file.filename, 'real.jpg');
  assert.equal(calls.upload[0].file.mimeType, 'image/jpeg');
  assert.equal(after, 1);
  assert.deepEqual(calls.notices, []);
  assert.deepEqual(calls.room, []);
});

test('too-large file: customer gets the too-large notice, agent a status, no rethrow', async (t) => {
  const calls = setup(t);
  const err = Object.assign(new Error('file too big'), { code: 'big' });
  await relayMediaToRocketChat(base(calls, { download: async () => { throw err; }, rethrow: true }));
  assert.deepEqual(calls.notices, ['TOO_LARGE']);
  assert.deepEqual(calls.room, ['status initial.jpg: file too big']);
  assert.equal(calls.upload.length, 0);
});

test('other failures: failed notice, agent status, and rethrow only when asked', async (t) => {
  const calls = setup(t);
  const boom = new Error('boom');
  await relayMediaToRocketChat(base(calls, { download: async () => { throw boom; } }));
  assert.deepEqual(calls.notices, ['FAILED']);
  await assert.rejects(
    relayMediaToRocketChat(base(calls, { download: async () => { throw boom; }, rethrow: true })),
    /boom/
  );
  assert.equal(calls.room.length, 2);
});

test('upload failure after download reports the downloaded filename; notice failure is swallowed', async (t) => {
  const calls = setup(t);
  rocketchat.uploadLivechatFile = async () => { throw new Error('upload down'); };
  await relayMediaToRocketChat(base(calls, {
    sendNotice: async () => { throw new Error('notice down'); },
  }));
  assert.deepEqual(calls.room, ['status real.jpg: upload down']);
});
