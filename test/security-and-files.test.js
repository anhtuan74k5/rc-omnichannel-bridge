const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const mappingFile = path.join(os.tmpdir(), `sec-mapping-${process.pid}.json`);
Object.assign(process.env, {
  MAPPING_FILE: mappingFile,
  ROCKETCHAT_URL: 'http://rc.test',
  ROCKETCHAT_AUTH_TOKEN: 'agent-token',
  ROCKETCHAT_USER_ID: 'agent-id',
  TELEGRAM_BOT_TOKEN: '1:test',
  AI_ENABLED: 'false',
});

const mapping = require('../src/core/mapping');
const rocketchat = require('../src/rocketchat/rocketchat');
const telegram = require('../src/platforms/telegram');
const { downloadRocketChatFile, isPermanentDownloadError } = require('../src/media/rocketchatFiles');
const { rocketChatFilePath } = require('../src/media/rocketchatFileUrl');
const { handleTelegramDocument } = require('../src/inbound/telegram');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function stub(t, target, replacements) {
  const saved = Object.fromEntries(Object.keys(replacements).map((key) => [key, target[key]]));
  Object.assign(target, replacements);
  t.after(() => Object.assign(target, saved));
}

test.after(() => { try { fs.unlinkSync(mappingFile); } catch { /* already gone */ } });

// ------------------------------------------------------------- visitor tokens

function captureRegistrations(t) {
  const visitors = [];
  stub(t, global, {
    fetch: async (url, options) => {
      assert.match(String(url), /\/api\/v1\/livechat\/visitor$/);
      visitors.push(JSON.parse(options.body).visitor);
      return json({ success: true });
    },
  });
  return visitors;
}

test('a new visitor gets a random token and e-mail, saved ones are reused', async (t) => {
  mapping.load();
  const visitors = captureRegistrations(t);
  mapping.getOrCreate('telegram', '100');
  mapping.getOrCreate('facebook', '100');

  const first = await rocketchat.getOrCreateVisitor('100', 'A', { platform: 'telegram' });
  const other = await rocketchat.getOrCreateVisitor('100', 'B', { platform: 'facebook' });
  assert.match(first, /^visitor_[0-9a-f]{48}$/);
  assert.notEqual(first, other, 'the same id on two platforms never shares a visitor');
  assert.ok(!JSON.stringify(visitors.map((v) => v.email)).includes('100@'), 'the e-mail is not guessable');

  mapping.update(mapping.findByPlatformUser('telegram', '100'), { visitorToken: first });
  assert.equal(await rocketchat.getOrCreateVisitor('100', 'A', { platform: 'telegram' }), first);
  assert.equal(visitors.length, 2);
});

test('a guessable token is revoked and replaced once its room is closed', async (t) => {
  mapping.load();
  const visitors = captureRegistrations(t);
  const entry = mapping.getOrCreate('telegram', '200');
  mapping.update(entry, { visitorToken: 'visitor_200', roomId: 'open-room' });

  assert.equal(await rocketchat.getOrCreateVisitor('200', 'A', { platform: 'telegram' }), 'visitor_200',
    'an open room keeps its token');

  mapping.update(entry, { roomId: null });
  const token = await rocketchat.getOrCreateVisitor('200', 'A', { platform: 'telegram' });
  assert.match(token, /^visitor_[0-9a-f]{48}$/);
  assert.deepEqual(visitors.map((v) => v.token), [token, token]);
  assert.equal(visitors[0].email, '200@bridge.local', 'the old e-mail takes over the old visitor record');
  assert.notEqual(visitors[1].email, '200@bridge.local');
});

// ---------------------------------------------------------- agent file download

test('only Rocket.Chat upload paths count as files', () => {
  assert.equal(rocketChatFilePath('/file-upload/a/b.png?x=1'), '/file-upload/a/b.png?x=1');
  assert.equal(rocketChatFilePath('https://chat.example.com/file-upload/a/b.png'), '/file-upload/a/b.png');
  assert.equal(rocketChatFilePath('//evil.example/file-upload/a'), '/file-upload/a');
  for (const bad of ['', 'https://evil.example/a.png', '/api/v1/users.list',
    '/file-upload/../api/v1/users.list', 'file:///etc/passwd']) {
    assert.equal(rocketChatFilePath(bad), null, bad);
  }
});

test('agent credentials are only ever sent to the configured Rocket.Chat', async (t) => {
  const outside = [];
  const server = http.createServer((req, res) => { outside.push(req.headers); res.end('stored'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const storage = `http://127.0.0.1:${server.address().port}`;
  const realFetch = global.fetch;
  const asked = [];
  stub(t, global, {
    fetch: async (url, options) => {
      asked.push({ url: String(url), headers: options.headers });
      if (String(url).startsWith(storage)) return realFetch(url, options);
      if (String(url).includes('/file-upload/s3/')) {
        return new Response(null, { status: 302, headers: { location: `${storage}/object` } });
      }
      return new Response('local');
    },
  });

  await assert.rejects(downloadRocketChatFile(`${storage}/a.png`), (error) => {
    assert.equal(error.code, 'ROCKETCHAT_FILE_URL_REJECTED');
    return isPermanentDownloadError(error);
  });
  assert.equal(asked.length, 0);

  await downloadRocketChatFile(`${storage}/file-upload/id/a.png`);
  assert.equal(asked[0].url, 'http://rc.test/file-upload/id/a.png');

  const file = await downloadRocketChatFile('/file-upload/s3/a.png');
  assert.equal(file.buffer.toString(), 'stored');
  assert.equal(outside.length, 1);
  assert.equal(outside[0]['x-auth-token'], undefined);
  assert.equal(outside[0]['x-user-id'], undefined);
});

test('a link card is not treated as a file, so its text is still delivered', () => {
  const found = rocketchat.extractAttachments({
    attachments: [{ title: 'News', title_link: 'https://news.example/story' }],
  });
  assert.deepEqual(found, []);
});

// ------------------------------------------------------------- Telegram files

function stubTelegramFile(t, { fileInfo, status = 200 } = {}) {
  const room = [];
  const customer = [];
  stub(t, global, {
    fetch: async (url) => (String(url).includes('/getFile')
      ? json(fileInfo || { ok: true, result: { file_path: 'documents/f', file_size: 3 } }, status)
      : new Response('abc')),
  });
  stub(t, rocketchat, {
    getOrCreateVisitor: async () => 'visitor_t',
    getOrCreateRoom: async () => 'room',
    uploadLivechatFile: async (token, roomId, file) => room.push(file.filename),
    sendMessageToRocketChat: async (token, roomId, text) => room.push(text),
  });
  stub(t, telegram, { sendMessage: async (chatId, text) => customer.push(text) });
  return { room, customer };
}

for (const name of ['order.zip', 'bill.xlsx', 'photo.jpg', 'scan.pdf']) {
  test(`a Telegram ${name} file reaches the agent with its caption`, async (t) => {
    mapping.load();
    const { room, customer } = stubTelegramFile(t);
    await handleTelegramDocument('300', { file_id: 'f', file_name: name }, 'please check');
    assert.deepEqual(room, [name, 'please check']);
    assert.deepEqual(customer, []);
  });
}

test('a file above the Bot API download limit is reported as too large', async (t) => {
  mapping.load();
  const { room, customer } = stubTelegramFile(t, {
    fileInfo: { ok: false, description: 'Bad Request: file is too big' }, status: 400,
  });
  await handleTelegramDocument('301', { file_id: 'f', file_name: 'video.mkv' });
  assert.equal(customer.length, 1);
  assert.match(customer[0], /too large/);
  assert.equal(room.length, 1);
});
