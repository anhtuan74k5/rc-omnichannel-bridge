const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// Isolate from the developer's real .env and mapping.json.
const mappingFile = path.join(os.tmpdir(), `ops-hardening-mapping-${process.pid}.json`);
process.env.MAPPING_FILE = mappingFile;
process.env.AI_ENABLED = 'false';
process.env.RATE_LIMIT_PER_MINUTE = '3';
process.env.WEBHOOK_BODY_LIMIT = '10kb';
process.env.REQUEST_BODY_LIMIT = '1mb';
process.env.TELEGRAM_POLLING = 'true';
process.env.TELEGRAM_WEBHOOK_SECRET = '';
process.env.FB_APP_SECRET = '';

const mapping = require('../mapping');
const rocketchat = require('../rocketchat');
const telegram = require('../telegram');
const { app, forwardToRocketChat } = require('../index');
const { createRateLimiter } = require('../rateLimiter');
const { createTimer } = require('../metrics');
const { resolveCustomerName, rememberTelegramName, telegramDisplayName } = require('../customerNames');
const { telegramWebhookRejection } = require('../webhookGuards');

test.after(() => { try { fs.unlinkSync(mappingFile); } catch { /* gone */ } });

async function listen(t) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

// ---------------- G9 ----------------

test('G9: Telegram display name from first/last name, then username', () => {
  assert.equal(telegramDisplayName({ first_name: 'An', last_name: 'Nguyen' }), 'An Nguyen');
  assert.equal(telegramDisplayName({ username: 'anny' }), '@anny');
  assert.equal(telegramDisplayName(undefined, { title: 'Group' }), 'Group');
  assert.equal(telegramDisplayName({}, {}), '');
});

test('G9: telegram name is remembered and cached on the mapping entry', async () => {
  rememberTelegramName(9001, { from: { first_name: 'Binh' }, chat: { id: 9001 } });
  assert.equal(await resolveCustomerName('telegram', 9001, 'TG 9001'), 'Binh');
  assert.equal(mapping.findByPlatformUser('telegram', 9001).displayName, 'Binh');
  // Cached: no new lookup needed even without the in-memory name.
  assert.equal(await resolveCustomerName('telegram', 9001, 'TG 9001'), 'Binh');
  // Unknown customer falls back and is not cached.
  assert.equal(await resolveCustomerName('telegram', 9002, 'TG 9002'), 'TG 9002');
});

test('G9: Facebook uses the profile lookup once, falls back on failure', async () => {
  let calls = 0;
  const ok = async () => { calls += 1; return 'Chi Le'; };
  assert.equal(await resolveCustomerName('facebook', 'psid1', 'FB psid1', { fetchProfileName: ok }), 'Chi Le');
  assert.equal(await resolveCustomerName('facebook', 'psid1', 'FB psid1', { fetchProfileName: ok }), 'Chi Le');
  assert.equal(calls, 1);

  const fail = async () => null;
  assert.equal(await resolveCustomerName('facebook', 'psid2', 'FB psid2', { fetchProfileName: fail }), 'FB psid2');
  assert.equal(await resolveCustomerName('facebook', 'psid2', 'FB psid2', { fetchProfileName: ok }), 'Chi Le');
});

// ---------------- G10 ----------------

test('G10: AI and platform modules never log customer message text', () => {
  const root = path.join(__dirname, '..');
  const ai = fs.readFileSync(path.join(root, 'ai.js'), 'utf8');
  assert.doesNotMatch(ai, /Asking AI to handle:/);
  for (const line of ai.split('\n').filter((l) => /(console|log)\.(log|info|warn|error)/.test(l))) {
    assert.doesNotMatch(line, /customerMessage(?!\)\.length)/, line);
  }
  const index = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  for (const line of index.split('\n').filter((l) => /console\.(log|warn)/.test(l))) {
    assert.doesNotMatch(line, /\$\{text\}|\$\{caption\}/, line);
  }
});

// ---------------- G11 ----------------

test('G11: stage timer reports each stage', () => {
  let now = 1000;
  const timer = createTimer(() => now);
  now += 30; timer.mark('ai');
  now += 120; timer.mark('rocketchat');
  assert.equal(timer.summary(), 'ai=30ms rocketchat=120ms total=150ms');
});

test('G11: /health exposes operational numbers and no secrets', async (t) => {
  const base = await listen(t);
  const body = await (await fetch(`${base}/health`)).json();
  for (const key of ['activeRooms', 'facebookQueueDepth', 'lastAgentPollAt', 'rocketChat429', 'customerRateLimited']) {
    assert.ok(key in body, key);
  }
  assert.equal(body.status, 'ok');
  assert.doesNotMatch(JSON.stringify(body), /token"\s*:\s*"/i);
});

// ---------------- G12 ----------------

test('G12: webhooks reject large bodies, upload keeps the large limit', async (t) => {
  const base = await listen(t);
  const big = JSON.stringify({ pad: 'x'.repeat(50 * 1024) });
  const headers = { 'content-type': 'application/json' };

  const fb = await fetch(`${base}/webhook/facebook`, { method: 'POST', headers, body: big });
  assert.equal(fb.status, 413);
  const tg = await fetch(`${base}/webhook/telegram`, { method: 'POST', headers, body: big });
  assert.equal(tg.status, 413);

  // Past the body parser (not 413): without ADMIN_API_KEY the endpoint answers 503.
  const upload = await fetch(`${base}/documents/upload`, { method: 'POST', headers, body: big });
  assert.notEqual(upload.status, 413);
});

// ---------------- G13 ----------------

test('G13: limiter allows up to the limit, notifies once, recovers after the window', () => {
  let now = 0;
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
  assert.equal(limiter.check('a').allowed, true);
  assert.equal(limiter.check('a').allowed, true);
  const third = limiter.check('a');
  assert.deepEqual(third, { allowed: false, notify: true });
  assert.deepEqual(limiter.check('a'), { allowed: false, notify: false });
  assert.equal(limiter.check('b').allowed, true); // other customers unaffected
  now = 1500;
  assert.equal(limiter.check('a').allowed, true);
  assert.equal(limiter.limitedTotal(), 2);
  limiter.sweep();
});

test('G13: a flooding customer is skipped after the limit and told once', async (t) => {
  const sent = [];
  const replies = [];
  const orig = {
    getOrCreateVisitor: rocketchat.getOrCreateVisitor,
    getOrCreateRoom: rocketchat.getOrCreateRoom,
    sendMessageToRocketChat: rocketchat.sendMessageToRocketChat,
    sendMessage: telegram.sendMessage,
  };
  rocketchat.getOrCreateVisitor = async (id) => `visitor_${id}`;
  rocketchat.getOrCreateRoom = async () => 'room1';
  rocketchat.sendMessageToRocketChat = async (token, room, text) => { sent.push(text); };
  telegram.sendMessage = async (id, text) => { replies.push(text); };
  t.after(() => { Object.assign(rocketchat, orig); telegram.sendMessage = orig.sendMessage; });

  for (let i = 0; i < 8; i += 1) {
    await forwardToRocketChat('telegram', 777, 'TG 777', `msg ${i}`);
  }
  assert.equal(sent.length, 3); // limit is 3 per minute
  assert.equal(replies.length, 1); // notified exactly once

  await forwardToRocketChat('telegram', 888, 'TG 888', 'other customer');
  assert.equal(sent.length, 4);
});

// ---------------- G18 ----------------

test('G18: Telegram webhook is off while polling, otherwise needs the secret', () => {
  assert.equal(telegramWebhookRejection({ pollingEnabled: true, secret: 's', header: 's' }), 404);
  assert.equal(telegramWebhookRejection({ pollingEnabled: false, secret: 's', header: 'x' }), 401);
  assert.equal(telegramWebhookRejection({ pollingEnabled: false, secret: 's', header: undefined }), 401);
  assert.equal(telegramWebhookRejection({ pollingEnabled: false, secret: 's', header: 's' }), null);
  assert.equal(telegramWebhookRejection({ pollingEnabled: false, secret: '', header: '' }), null);
});

test('G18: the route answers 404 when polling is enabled', async (t) => {
  const base = await listen(t);
  const res = await fetch(`${base}/webhook/telegram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 404);
});
