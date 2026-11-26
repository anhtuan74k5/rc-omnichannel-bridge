/**
 * Automated matrix: T-F13, T-F14, T-F11, T-S03, T-S04, T-H02, T-S05.
 * Rocket.Chat is stubbed in-process; no real service or port 3001 is touched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const mappingFile = path.join(os.tmpdir(), `auto-sec-mapping-${process.pid}.json`);
process.env.MAPPING_FILE = mappingFile;
process.env.AI_ENABLED = 'false';
process.env.FB_APP_SECRET = 'auto-sec-app-secret-VALUE';
process.env.FB_PAGE_ACCESS_TOKEN = 'EAAG-auto-sec-page-token-VALUE';
process.env.FB_VERIFY_TOKEN = 'auto-sec-verify-token-VALUE';
process.env.TELEGRAM_BOT_TOKEN = '999:auto-sec-bot-token-VALUE';
process.env.ROCKETCHAT_AUTH_TOKEN = 'auto-sec-rc-token-VALUE';
process.env.ROCKETCHAT_USER_ID = 'auto-sec-rc-user';
process.env.ROCKETCHAT_URL = 'http://rocketchat.invalid';
process.env.RATE_LIMIT_PER_MINUTE = '0';
process.env.NODE_ENV = 'test';
// Profile lookups go to a dead local port, never to the real Graph API.
process.env.FB_GRAPH_BASE_URL = 'http://127.0.0.1:9';

// T-S05: record everything the bridge prints during this whole file.
const logLines = [];
for (const method of ['log', 'info', 'warn', 'error']) {
  const original = console[method];
  console[method] = (...args) => {
    logLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    if (process.env.AUTO_TEST_VERBOSE) original(...args);
  };
}

const mapping = require('../src/core/mapping');
const rocketchat = require('../src/rocketchat/rocketchat');
const facebook = require('../src/platforms/facebook');
const { app, facebookQueue } = require('..');
const { MESSAGES } = require('../src/constants/messages');
const {
  downloadFacebookAttachment,
  isFacebookFileTooLarge,
} = require('../src/media/facebookFiles');

const SECRET = process.env.FB_APP_SECRET;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = { room: [], uploads: [], toCustomer: [] };
const saved = {
  getOrCreateVisitor: rocketchat.getOrCreateVisitor,
  getOrCreateRoom: rocketchat.getOrCreateRoom,
  sendMessageToRocketChat: rocketchat.sendMessageToRocketChat,
  uploadLivechatFile: rocketchat.uploadLivechatFile,
  fbSendMessage: facebook.sendMessage,
  fetch: global.fetch,
};

test.before(() => {
  mapping.load();
  rocketchat.getOrCreateVisitor = async (id) => `visitor_${id}`;
  rocketchat.getOrCreateRoom = async () => 'room-auto';
  rocketchat.sendMessageToRocketChat = async (token, room, text) => { state.room.push(text); return { success: true }; };
  rocketchat.uploadLivechatFile = async (token, room, file) => { state.uploads.push(file.filename); return { success: true }; };
  facebook.sendMessage = async (psid, text) => { state.toCustomer.push(text); };
});
test.after(() => {
  Object.assign(rocketchat, {
    getOrCreateVisitor: saved.getOrCreateVisitor,
    getOrCreateRoom: saved.getOrCreateRoom,
    sendMessageToRocketChat: saved.sendMessageToRocketChat,
    uploadLivechatFile: saved.uploadLivechatFile,
  });
  facebook.sendMessage = saved.fbSendMessage;
  global.fetch = saved.fetch;
  try { fs.unlinkSync(mappingFile); } catch { /* gone */ }
});
test.beforeEach(() => {
  state.room.length = 0;
  state.uploads.length = 0;
  state.toCustomer.length = 0;
  global.fetch = saved.fetch;
});

let baseUrl;
let server;
test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const sign = (body, secret = SECRET) =>
  `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
const signedHeaders = (body) => ({ 'content-type': 'application/json', 'x-hub-signature-256': sign(body) });
const textEvent = (psid, mid, text) => ({ sender: { id: psid }, message: { mid, text } });
const pagePayload = (...events) => JSON.stringify({ object: 'page', entry: [{ messaging: events }] });
const post = (body, headers) => fetch(`${baseUrl}/webhook/facebook`, { method: 'POST', headers, body });

// ---------------------------------------------------------------- T-F13

test('T-F13: missing, wrong, forged and tampered signatures get 401 and nothing is processed', async () => {
  const body = pagePayload(textEvent('f13-user', 'mid-f13-1', 'should never arrive'));
  const json = { 'content-type': 'application/json' };
  const cases = {
    'no header': json,
    'empty header': { ...json, 'x-hub-signature-256': '' },
    'wrong scheme (sha1=)': { ...json, 'x-hub-signature-256': sign(body).replace('sha256=', 'sha1=') },
    'non-hex garbage': { ...json, 'x-hub-signature-256': 'sha256=zzzz' },
    'truncated digest': { ...json, 'x-hub-signature-256': sign(body).slice(0, 40) },
    'signed with another secret': { ...json, 'x-hub-signature-256': sign(body, 'not-the-secret') },
    'signature of a different body': { ...json, 'x-hub-signature-256': sign(body + ' ') },
  };
  for (const [label, headers] of Object.entries(cases)) {
    const res = await post(body, headers);
    assert.equal(res.status, 401, label);
  }
  // Body altered after it was signed.
  const tampered = body.replace('should never arrive', 'tampered content');
  const res = await post(tampered, { ...json, 'x-hub-signature-256': sign(body) });
  assert.equal(res.status, 401, 'tampered body');

  assert.equal(await facebookQueue.idle(2000), true);
  assert.equal(state.room.length, 0, 'rejected requests must not reach Rocket.Chat');
  assert.equal(mapping.findByPlatformUser('facebook', 'f13-user'), undefined, 'no mapping entry created');
});

test('T-F13: replaying a correctly signed webhook is accepted by the signature check but processed once', async () => {
  // A Meta signature carries no timestamp, so a replay cannot be told from a retry
  // by the signature; the mid-based dedupe is what protects the room.
  const body = pagePayload(textEvent('f13-replay', 'mid-f13-replay', 'hello once'));
  for (let i = 0; i < 3; i += 1) {
    const res = await post(body, signedHeaders(body));
    assert.equal(res.status, 200);
    assert.equal(await facebookQueue.idle(2000), true);
  }
  assert.deepEqual(state.room, ['hello once']);
});

// ---------------------------------------------------------------- T-F14

test('T-F14: malformed or unexpected payloads never crash the server', async () => {
  const json = (body) => ({ body, headers: signedHeaders(body) });
  const payloads = {
    'invalid JSON': ['{"object":"page",', [400]],
    'JSON null': ['null', [400]],
    'JSON number': ['42', [400]],
    'empty body': ['', [200, 400]],
    'array body': ['[]', [200]],
    'object is not page': [JSON.stringify({ object: 'user', entry: [{ messaging: [textEvent('x', 'm', 'hi')] }] }), [200]],
    'entry empty': [JSON.stringify({ object: 'page', entry: [] }), [200]],
    'entry missing': [JSON.stringify({ object: 'page' }), [200]],
    'entry is null element': [JSON.stringify({ object: 'page', entry: [null] }), [200]],
    'messaging is a number': [JSON.stringify({ object: 'page', entry: [{ messaging: 5 }] }), [200]],
    'event without sender': [pagePayload({ message: { mid: 'm1', text: 'x' } }), [200]],
    'event without message (read receipt)': [pagePayload({ sender: { id: 'r1' }, read: { watermark: 1 } }), [200]],
    'echo message': [pagePayload({ sender: { id: 'r2' }, message: { mid: 'm2', text: 'echo', is_echo: true } }), [200]],
    'attachments is not an array': [pagePayload({ sender: { id: 'r3' }, message: { mid: 'm3', attachments: 'oops' } }), [200]],
  };
  for (const [label, [body, allowed]] of Object.entries(payloads)) {
    const { headers } = json(body);
    const res = await post(body, headers);
    assert.ok(allowed.includes(res.status), `${label}: got ${res.status}, expected one of ${allowed}`);
    // Error responses must not leak a stack trace or file paths.
    if (res.status >= 400) {
      const text = await res.text();
      assert.doesNotMatch(text, /node_modules|\.js:\d+/, `${label}: response leaks internals`);
    }
  }
  assert.equal(await facebookQueue.idle(2000), true);
  assert.equal(state.room.length, 0, 'none of these may produce a room message');

  // Still alive afterwards.
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
});

// ---------------------------------------------------------------- T-S04

test('T-S04: an oversized body is refused with 413 on every webhook and the server keeps serving', async () => {
  const huge = JSON.stringify({ object: 'page', pad: 'x'.repeat(1.5 * 1024 * 1024) });
  const headers = { 'content-type': 'application/json' };
  for (const route of ['/webhook/facebook', '/webhook/telegram', '/webhook/rocketchat']) {
    const res = await fetch(`${baseUrl}${route}`, { method: 'POST', headers: { ...headers, 'x-hub-signature-256': sign(huge) }, body: huge });
    assert.equal(res.status, 413, route);
  }
  const ok = await fetch(`${baseUrl}/health`);
  assert.equal(ok.status, 200);
});

// ---------------------------------------------------------------- T-H02

test('T-H02: the same mid delivered many times, concurrently and after a reload, is processed once', async () => {
  const body = pagePayload(textEvent('h02-user', 'mid-h02-a', 'one'), textEvent('h02-user', 'mid-h02-b', 'two'));
  // Five simultaneous redeliveries.
  const responses = await Promise.all(Array.from({ length: 5 }, () => post(body, signedHeaders(body))));
  assert.ok(responses.every((r) => r.status === 200));
  assert.equal(await facebookQueue.idle(5000), true);
  assert.deepEqual(state.room, ['one', 'two']);

  // Bridge restarts: state is reloaded from mapping.json, Meta retries again.
  mapping.load();
  const retry = await post(body, signedHeaders(body));
  assert.equal(retry.status, 200);
  assert.equal(await facebookQueue.idle(5000), true);
  assert.deepEqual(state.room, ['one', 'two'], 'redelivery after a reload must be ignored');

  // A new mid is still processed.
  const fresh = pagePayload(textEvent('h02-user', 'mid-h02-c', 'three'));
  await post(fresh, signedHeaders(fresh));
  assert.equal(await facebookQueue.idle(5000), true);
  assert.deepEqual(state.room, ['one', 'two', 'three']);
});

// ---------------------------------------------------------------- T-S03 / T-F11

const BAD_URLS = [
  'http://169.254.169.254/latest/meta-data/',
  'https://169.254.169.254/latest/meta-data/',
  'https://[fd00:ec2::254]/latest/meta-data/',
  'http://localhost:3001/health',
  'https://localhost/x.jpg',
  'https://127.0.0.1/x.jpg',
  'https://10.0.0.5/x.jpg',
  'https://evil.example.com/photo.jpg',
  'https://fbcdn.net.evil.example.com/photo.jpg',
  'https://evilfbcdn.net/photo.jpg',
  'https://scontent.xx.fbcdn.net@evil.example.com/photo.jpg',
  'https://evil.example.com/?next=https://x.fbcdn.net/a.jpg',
  'http://scontent.xx.fbcdn.net/a.jpg', // plain http
  'ftp://scontent.xx.fbcdn.net/a.jpg',
  'file:///etc/passwd',
  'javascript:alert(1)',
  'not a url',
  '',
];

test('T-S03: attachment URLs pointing at metadata, localhost or foreign hosts are refused before any request', async () => {
  const calls = [];
  global.fetch = async (url) => { calls.push(String(url)); throw new Error('network must not be used'); };
  for (const url of BAD_URLS) {
    await assert.rejects(() => downloadFacebookAttachment(url), (err) => {
      assert.equal(err.code, 'FACEBOOK_MEDIA_URL_REJECTED', url);
      return true;
    });
  }
  assert.deepEqual(calls, [], 'no request may leave the process for a rejected URL');
});

test('T-S03: a CDN URL that redirects elsewhere is not followed (open-redirect SSRF)', async () => {
  let seenOptions;
  global.fetch = async (url, options) => {
    seenOptions = options;
    return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
  };
  await assert.rejects(() => downloadFacebookAttachment('https://scontent.xx.fbcdn.net/v/t1/a.jpg'));
  assert.equal(seenOptions && seenOptions.redirect, 'manual', 'the download must not auto-follow redirects');
});

function fakeCdnResponse({ size, declare = true }) {
  const buffer = Buffer.alloc(size, 1);
  const headers = { 'content-type': 'image/jpeg' };
  if (declare) headers['content-length'] = String(size);
  return new Response(buffer, { status: 200, headers });
}

test('T-F11: files over 25 MB are refused (declared and undeclared), exactly 25 MB passes', async () => {
  const limit = 25 * 1024 * 1024;
  global.fetch = async () => fakeCdnResponse({ size: limit + 1 });
  await assert.rejects(() => downloadFacebookAttachment('https://scontent.xx.fbcdn.net/big.jpg'), isFacebookFileTooLarge);

  global.fetch = async () => fakeCdnResponse({ size: limit + 1, declare: false });
  await assert.rejects(() => downloadFacebookAttachment('https://scontent.xx.fbcdn.net/big2.jpg'), isFacebookFileTooLarge);

  global.fetch = async () => fakeCdnResponse({ size: limit });
  const ok = await downloadFacebookAttachment('https://scontent.xx.fbcdn.net/edge.jpg');
  assert.equal(ok.size, limit);
});

function attachmentEvent(psid, mid, url, type = 'image') {
  return textEventless(psid, mid, [{ type, payload: { url } }]);
}
function textEventless(psid, mid, attachments) {
  return { sender: { id: psid }, message: { mid, attachments } };
}

async function sendAttachmentWebhook(event) {
  const body = pagePayload(event);
  const res = await post(body, signedHeaders(body));
  assert.equal(res.status, 200);
  assert.equal(await facebookQueue.idle(5000), true);
}

test('T-F11: oversized file end to end: customer is told, agent sees a status, nothing uploaded, no crash', async () => {
  global.fetch = (url, options) => (String(url).startsWith('http://127.0.0.1')
    ? saved.fetch(url, options)
    : Promise.resolve(fakeCdnResponse({ size: 26 * 1024 * 1024 })));
  await sendAttachmentWebhook(attachmentEvent('f11-big', 'mid-f11-big', 'https://scontent.xx.fbcdn.net/huge.jpg'));
  assert.deepEqual(state.toCustomer, [MESSAGES.facebook.mediaTooLarge]);
  assert.equal(state.uploads.length, 0);
  assert.equal(state.room.length, 1, 'agent gets one status message');
});

test('T-F11: expired CDN URL (403) is reported to the customer without crashing', async () => {
  global.fetch = (url, options) => (String(url).startsWith('http://127.0.0.1')
    ? saved.fetch(url, options)
    : Promise.resolve(new Response('expired', { status: 403 })));
  await sendAttachmentWebhook(attachmentEvent('f11-exp', 'mid-f11-exp', 'https://scontent.xx.fbcdn.net/old.jpg'));
  assert.deepEqual(state.toCustomer, [MESSAGES.facebook.mediaUploadFailed]);
  assert.equal(state.uploads.length, 0);
});

test('T-F11/T-S03: a foreign or metadata host in a webhook never triggers a download', async () => {
  const outbound = [];
  global.fetch = (url, options) => {
    if (String(url).startsWith('http://127.0.0.1')) return saved.fetch(url, options);
    if (String(url).startsWith('https://graph.facebook.com/')) return Promise.reject(new Error('profile lookup blocked'));
    outbound.push(String(url));
    return Promise.reject(new Error('blocked'));
  };
  await sendAttachmentWebhook(attachmentEvent('f11-host', 'mid-f11-host-1', 'https://evil.example.com/a.jpg'));
  await sendAttachmentWebhook(attachmentEvent('f11-host', 'mid-f11-host-2', 'http://169.254.169.254/latest/meta-data/'));
  await sendAttachmentWebhook(attachmentEvent('f11-host', 'mid-f11-host-3', 'https://localhost/a.jpg'));
  assert.deepEqual(outbound, []);
  assert.equal(state.toCustomer.length, 3);
  assert.equal(state.uploads.length, 0);
});

// ---------------------------------------------------------------- T-S05 (must run last)

test('T-S05: logs written during this file hold no tokens or message content, only lengths', async () => {
  // Distinctive content, sent through the same paths as real traffic.
  const secretText = 'NOI-DUNG-RIENG-TU-KHONG-DUOC-GHI-LOG-12345';
  const body = pagePayload(textEvent('s05-user', 'mid-s05', secretText));
  await post(body, signedHeaders(body));
  assert.equal(await facebookQueue.idle(5000), true);
  assert.deepEqual(state.room, [secretText], 'the message itself did reach the room');

  const joined = logLines.join('\n');
  assert.ok(joined.length > 0, 'something must have been logged');
  const forbidden = [
    process.env.FB_APP_SECRET,
    process.env.FB_PAGE_ACCESS_TOKEN,
    process.env.FB_VERIFY_TOKEN,
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.ROCKETCHAT_AUTH_TOKEN,
    secretText,
    'tampered content',
    'should never arrive',
    'hello once',
  ];
  for (const needle of forbidden) {
    assert.ok(!joined.includes(needle), `log output contains a secret or message text: ${needle.slice(0, 12)}…`);
  }
  assert.match(joined, /length/i, 'lengths are logged instead of content');
});
