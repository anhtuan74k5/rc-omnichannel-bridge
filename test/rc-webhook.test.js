const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const mappingFile = path.join(os.tmpdir(), `rc-webhook-mapping-${process.pid}.json`);
process.env.MAPPING_FILE = mappingFile;
process.env.AI_ENABLED = 'false';
process.env.ROCKETCHAT_WEBHOOK_SECRET = 'rc-hook-secret';

const mapping = require('../mapping');
const telegram = require('../telegram');
const { app, deliverAgentMessages, rcWebhook } = require('../index');
const { createRocketChatWebhook, parseEvent } = require('../rcWebhook');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HEADER = 'X-RocketChat-Livechat-Token';
const fakeRes = () => ({
  status(code) { this.code = code; return this; },
  send() { return this; },
  sendStatus(code) { this.code = code; return this; },
});

// Shape produced by Rocket.Chat 8.9.0 sendToCRM('Message', room, [message]).
function agentMessagePayload(overrides = {}) {
  return {
    type: 'Message',
    _id: 'room-1',
    visitor: { _id: 'v1', token: 'visitor-token-1', username: 'guest-1' },
    agent: { _id: 'a1', username: 'agent' },
    messages: [{
      _id: 'msg-1', username: 'agent', msg: 'Xin chao', ts: '2026-11-24T10:00:00.000Z',
      rid: 'room-1', agentId: 'a1', _updatedAt: '2026-11-24T10:00:00.000Z',
    }],
    ...overrides,
  };
}

async function startServer(t) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/webhook/rocketchat`;
}

function post(url, body, token = 'rc-hook-secret') {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { [HEADER]: token } : {}) },
    body: JSON.stringify(body),
  });
}

test('parseEvent maps Rocket.Chat payloads to bridge actions', () => {
  const agent = parseEvent(agentMessagePayload());
  assert.equal(agent.kind, 'agent-messages');
  assert.equal(agent.roomId, 'room-1');
  assert.equal(agent.messages.length, 1);

  // Customer echo (no agentId), closing comment, app blocks and garbage.
  const echo = agentMessagePayload();
  delete echo.messages[0].agentId;
  assert.equal(parseEvent(echo).kind, 'alive');
  assert.equal(parseEvent(agentMessagePayload({ messages: [{ _id: 'c', msg: 'bye', agentId: 'a1', closingMessage: true }] })).kind, 'alive');
  assert.equal(parseEvent(agentMessagePayload({ messages: [{ _id: 'b', msg: '[{"a":1}]', agentId: 'a1', blocks: [{}] }] })).kind, 'alive');
  assert.equal(parseEvent(null).kind, 'ignored');
  assert.equal(parseEvent({ type: 'Unknown' }).kind, 'ignored');

  assert.equal(parseEvent({ type: 'LivechatSessionTaken', _id: 'room-1' }).kind, 'alive');
  assert.equal(parseEvent({ type: 'LivechatSession', _id: 'room-1', closedAt: '2026-11-24T10:05:00Z' }).kind, 'closed');
  assert.equal(parseEvent({ type: 'LivechatSession', _id: 'room-1' }).kind, 'alive');

  // File message: msg may be missing; attachments are kept for the normal send path.
  const file = parseEvent(agentMessagePayload({ messages: [{
    _id: 'f1', agentId: 'a1', ts: '2026-11-24T10:00:00Z',
    file: { _id: 'file1', name: 'a.png', type: 'image/png', size: 5 },
    attachments: [{ title: 'a.png', title_link: '/file-upload/file1/a.png' }],
  }] }));
  assert.equal(file.kind, 'agent-messages');
  assert.equal(file.messages[0].msg, '');
});

test('route rejects a missing or wrong token and accepts the right one', async (t) => {
  const url = await startServer(t);
  assert.equal((await post(url, agentMessagePayload(), null)).status, 401);
  assert.equal((await post(url, agentMessagePayload(), 'wrong-secret')).status, 401);
  const ok = await post(url, { type: 'LivechatSessionTaken', _id: 'unknown-room' });
  assert.equal(ok.status, 200);
});

test('webhook is disabled without a secret', () => {
  const hook = createRocketChatWebhook({ secret: '' });
  const res = fakeRes();
  hook.handler({ get: () => '', body: {} }, res);
  assert.equal(res.code, 503);
  assert.equal(hook.shouldPoll(), true);
});

test('webhook push and polling deliver an agent message exactly once', async (t) => {
  t.after(() => { try { fs.unlinkSync(mappingFile); } catch { /* already gone */ } });
  const originalSend = telegram.sendMessage;
  t.after(() => { telegram.sendMessage = originalSend; });
  const sent = [];
  telegram.sendMessage = async (chatId, text) => { sent.push({ chatId, text }); };

  mapping.load();
  const entry = mapping.getOrCreate('telegram', '555');
  mapping.update(entry, { visitorToken: 'visitor-token-1', roomId: 'room-1' });
  const url = await startServer(t);

  // 1. Webhook delivers it.
  assert.equal((await post(url, agentMessagePayload())).status, 200);
  await delay(100);
  assert.deepEqual(sent.map((s) => s.text), ['Xin chao']);
  assert.ok(entry.agentActiveAt > 0, 'agent activity pauses the AI');
  assert.deepEqual(entry.processedMessageIds, ['msg-1']);

  // 2. Rocket.Chat redelivers the same event: ignored.
  await post(url, agentMessagePayload());
  await delay(100);
  assert.equal(sent.length, 1);

  // 3. Polling fetched the same message in the meantime: ignored too.
  await deliverAgentMessages(entry, [{ _id: 'msg-1', msg: 'Xin chao', ts: '2026-11-24T10:00:00.000Z' }]);
  assert.equal(sent.length, 1);

  // 4. Polling and webhook race on a new message: one send.
  const second = { _id: 'msg-2', msg: 'Tiep', ts: '2026-11-24T10:01:00.000Z' };
  await Promise.all([
    deliverAgentMessages(entry, [second]),
    post(url, agentMessagePayload({ messages: [{ ...second, agentId: 'a1', rid: 'room-1' }] })),
  ]);
  await delay(100);
  assert.deepEqual(sent.map((s) => s.text), ['Xin chao', 'Tiep']);

  // 5. Unknown room: nothing is sent.
  await post(url, agentMessagePayload({ _id: 'other-room' }));
  await delay(50);
  assert.equal(sent.length, 2);
  assert.ok(rcWebhook.status().alive);
});

test('a failed push makes polling retry at once; close is left to polling', async () => {
  const time = 1_000_000;
  const pushes = [];
  const hook = createRocketChatWebhook({
    secret: 's', silenceMs: 300000, fallbackPollMs: 60000, now: () => time,
    findEntry: () => ({ id: 'e' }),
    deliver: async (entry, messages) => { pushes.push(messages.length); return { pending: true }; },
  });
  const req = (body) => ({ get: () => 's', body });

  hook.handler(req(agentMessagePayload()), fakeRes());
  await delay(10);
  assert.deepEqual(pushes, [1]);
  assert.equal(hook.shouldPoll(), true, 'pending delivery forces a poll');
  assert.equal(hook.shouldPoll(), false, 'then back to the slow rate');

  hook.handler(req({ type: 'LivechatSession', _id: 'room-1', closedAt: 'x' }), fakeRes());
  await delay(10);
  assert.equal(hook.shouldPoll(), true, 'closing is handled by polling');
});

test('polling slows down while the webhook is alive and recovers when it goes silent', () => {
  let time = 10_000_000;
  const hook = createRocketChatWebhook({
    secret: 's', silenceMs: 300000, fallbackPollMs: 60000, now: () => time,
    findEntry: () => null, deliver: async () => ({}),
  });

  assert.equal(hook.shouldPoll(), true, 'no event yet: full-rate polling');
  hook.handler({ get: () => 's', body: { type: 'LivechatSessionTaken', _id: 'x' } }, fakeRes());
  assert.equal(hook.isAlive(), true);

  let polls = 0;
  for (let i = 0; i < 12; i += 1) { // 2 minutes of 10 s ticks
    time += 10000;
    if (hook.shouldPoll()) polls += 1;
  }
  assert.equal(polls, 2, 'about one poll per minute while alive');

  time += 300001; // silent past the threshold
  assert.equal(hook.isAlive(), false);
  assert.equal(hook.shouldPoll() && hook.shouldPoll(), true, 'every tick polls again');
});
