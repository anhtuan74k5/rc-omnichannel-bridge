/**
 * Automated matrix: T-F24, T-F25, T-T19, T-T20, T-A05, T-S06, T-H06, T-H09.
 * Graph and Telegram are the local mock (scripts/e2e/mock-platforms.js), the AI is a local
 * stub server and Rocket.Chat is stubbed in-process. Nothing leaves the machine.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { createMock } = require('../scripts/e2e/mock-platforms');

const tmp = (name) => path.join(os.tmpdir(), `auto-del-${process.pid}-${name}`);
const mappingFile = tmp('mapping.json');
const mock = createMock();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let mapping; let rocketchat; let facebook; let telegram; let indexModule; let MESSAGES;
let aiServer; let appPort;
const ai = { mode: 'decline', calls: 0 };
const room = [];
const consoleErrors = [];

async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test.before(async () => {
  const mockPort = await mock.listen(0);
  aiServer = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      ai.calls += 1;
      if (ai.mode === 'hang') return; // never answers
      if (ai.mode === 'http500') {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'boom sk-LEAKED-KEY upstream failure' } }));
      }
      const content = ai.mode === 'garbage' ? 'this is <html> not json'
        : JSON.stringify(ai.mode === 'answer' ? { handled: true, reply: 'AI says hi' } : { handled: false });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((resolve) => aiServer.listen(0, '127.0.0.1', resolve));

  appPort = await freePort();
  Object.assign(process.env, {
    PORT: String(appPort),
    MAPPING_FILE: mappingFile,
    FB_GRAPH_BASE_URL: `http://127.0.0.1:${mockPort}`,
    TELEGRAM_API_BASE_URL: `http://127.0.0.1:${mockPort}`,
    FB_PAGE_ACCESS_TOKEN: 'mock-page-token',
    FB_APP_SECRET: 'auto-del-app-secret',
    TELEGRAM_BOT_TOKEN: '123:mock-bot-token',
    ROCKETCHAT_URL: 'http://rocketchat.invalid',
    ROCKETCHAT_AUTH_TOKEN: 'rc-token',
    ROCKETCHAT_USER_ID: 'rc-user',
    HTTP_TIMEOUT_MS: '300',
    ROCKETCHAT_MAX_MESSAGE_RETRIES: '3',
    AI_ENABLED: 'true',
    AI_API_KEY: 'auto-del-ai-key',
    AI_BASE_URL: `http://127.0.0.1:${aiServer.address().port}`,
    AI_TIMEOUT_MS: '400',
    RATE_LIMIT_PER_MINUTE: '20',
  });

  const originalError = console.error;
  console.error = (...args) => {
    consoleErrors.push(args.map(String).join(' '));
    if (process.env.AUTO_TEST_VERBOSE) originalError(...args);
  };
  const originalLog = console.log;
  console.log = (...args) => { if (process.env.AUTO_TEST_VERBOSE) originalLog(...args); };

  mapping = require('../src/core/mapping');
  rocketchat = require('../src/rocketchat/rocketchat');
  facebook = require('../src/platforms/facebook');
  telegram = require('../src/platforms/telegram');
  ({ MESSAGES } = require('../src/constants/messages'));
  indexModule = require('..');
  mapping.load();

  rocketchat.getOrCreateVisitor = async (id) => `visitor_${id}`;
  rocketchat.getOrCreateRoom = async (token) => `room_${token}`;
  rocketchat.sendMessageToRocketChat = async (token, roomId, text) => { room.push(text); return { success: true }; };
});
test.after(async () => {
  await mock.close();
  await new Promise((resolve) => aiServer.close(resolve));
  for (const file of fs.readdirSync(os.tmpdir())) {
    if (file.startsWith(`auto-del-${process.pid}-`)) { try { fs.unlinkSync(path.join(os.tmpdir(), file)); } catch { /* gone */ } }
  }
});
test.beforeEach(() => { mock.clear(); room.length = 0; consoleErrors.length = 0; ai.calls = 0; });

let seq = 0;
const makeMessage = (text) => ({ _id: `auto-m${++seq}`, msg: text, ts: new Date().toISOString() });
function agentEntry(platform, id) {
  const entry = mapping.getOrCreate(platform, id);
  mapping.update(entry, { visitorToken: `visitor_${id}`, roomId: `room_${id}` });
  return entry;
}
const deliver = (entry, ...messages) => indexModule.deliverAgentMessages(entry, messages);
const graphSends = () => mock.requests.filter((r) => r.route === 'me/messages').length;
const tgSends = () => mock.requests.filter((r) => r.route === 'sendMessage').length;
const isProcessed = (entry, message) => (entry.processedMessageIds || []).includes(message._id);

// ------------------------------------------------------------------ T-F24

test('T-F24: a revoked Page token (190) is alerted loudly, retried a bounded number of times, then reported to the agent', async () => {
  const entry = agentEntry('facebook', 'f24');
  const message = makeMessage('xin chào khách');
  mock.inject('facebook', 'fb-190', 0); // sticky: every call fails

  const rounds = [];
  for (let i = 0; i < 6; i += 1) {
    const result = await deliver(entry, message); // one call = one poll/webhook round
    rounds.push(result.pending);
    if (isProcessed(entry, message)) break;
  }
  assert.deepEqual(rounds, [true, true, false], 'two retries are allowed, the third failure gives up');
  assert.equal(graphSends(), 3, 'exactly ROCKETCHAT_MAX_MESSAGE_RETRIES attempts, never infinite');
  assert.ok(isProcessed(entry, message), 'the message is closed so polling stops re-sending it');
  assert.equal(room.length, 1, 'the agent gets exactly one failure notice');
  assert.match(room[0], /Facebook|facebook/);
  assert.ok(consoleErrors.some((line) => line.includes('[ALERT] facebook credentials rejected')), 'alert in the log');

  // The /health endpoint shows the problem to the operator.
  const server = http.createServer(indexModule.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const health = await (await fetch(`http://127.0.0.1:${server.address().port}/health`)).json();
    assert.ok(health.credentialsRejectedAt.facebook > 0, '/health reports the rejected facebook credentials');
    assert.equal(health.credentialsRejectedAt.telegram, null);
    assert.doesNotMatch(JSON.stringify(health), /mock-page-token|auto-del-app-secret/);
  } finally {
    server.close();
  }

  // Later rounds do not resend the closed message.
  await deliver(entry, message);
  assert.equal(graphSends(), 3);
});

// ------------------------------------------------------------------ T-F25

for (const [fault, label] of [['http-500', 'Graph 5xx'], ['http-503', 'Graph 503'], ['http-429', 'Graph 429'], ['fb-rate', 'Graph rate-limit code 4'], ['timeout', 'Graph timeout']]) {
  test(`T-F25: ${label}: first attempt fails, the retry succeeds, the customer gets the message exactly once`, async () => {
    const entry = agentEntry('facebook', `f25-${fault}`);
    const message = makeMessage(`retry ${fault}`);
    mock.inject('facebook', fault, 1);

    const started = Date.now();
    const first = await deliver(entry, message);
    assert.equal(first.pending, true, 'a transient failure keeps the message for a retry');
    assert.equal(isProcessed(entry, message), false);
    assert.equal(room.length, 0, 'no failure notice while a retry is still possible');

    const second = await deliver(entry, message);
    const elapsed = Date.now() - started;
    assert.equal(second.pending, false);
    assert.ok(isProcessed(entry, message));
    assert.equal(graphSends(), 2, 'one failed + one successful request');

    // Even if the poller and the webhook both redeliver it now, nothing is sent twice.
    await deliver(entry, message);
    await deliver(entry, message);
    assert.equal(graphSends(), 2, 'no duplicate after success');
    assert.ok(elapsed < 3000, `recovered in ${elapsed} ms`);
  });
}

test('T-F25: persistent Graph 5xx gives up after the retry budget and tells the agent once', async () => {
  const entry = agentEntry('facebook', 'f25-sticky');
  const message = makeMessage('never delivered');
  mock.inject('facebook', 'http-500', 0);
  for (let i = 0; i < 5; i += 1) await deliver(entry, message);
  assert.equal(graphSends(), 3);
  assert.equal(room.length, 1);
  assert.ok(isProcessed(entry, message));
});

test('T-F23/F24: permanent Graph errors (24 h window, blocked) are not retried and reach the agent immediately', async () => {
  for (const fault of ['fb-10', 'fb-551']) {
    const entry = agentEntry('facebook', `f23-${fault}`);
    const message = makeMessage('too late');
    mock.clear();
    room.length = 0;
    mock.inject('facebook', fault, 0);
    const result = await deliver(entry, message);
    assert.equal(result.pending, false, fault);
    assert.equal(graphSends(), 1, `${fault}: one attempt only`);
    assert.equal(room.length, 1, `${fault}: agent informed`);
    mock.inject('facebook', 'fb-10', 0);
    mock.clear();
  }
});

// ------------------------------------------------------------------ T-T19

for (const [fault, label] of [['tg-403', 'bot blocked by the customer (403)'], ['tg-400-chat', 'chat not found (400)']]) {
  test(`T-T19: ${label} is classified permanent: one attempt, agent told, no endless retry`, async () => {
    const entry = agentEntry('telegram', `t19-${fault}`);
    const message = makeMessage('hello telegram');
    mock.inject('telegram', fault, 0);
    const result = await deliver(entry, message);
    assert.equal(result.pending, false);
    assert.equal(tgSends(), 1);
    assert.ok(isProcessed(entry, message));
    assert.equal(room.length, 1);
    assert.match(room[0], /Telegram|telegram/);
    await deliver(entry, message);
    assert.equal(tgSends(), 1, 'the closed message is never resent');
  });
}

test('T-T19: an invalid bot token (401) raises the alert on /health and stops after the retry budget', async () => {
  const entry = agentEntry('telegram', 't19-401');
  const message = makeMessage('auth failure');
  mock.inject('telegram', 'tg-401', 0);
  for (let i = 0; i < 5; i += 1) await deliver(entry, message);
  assert.equal(tgSends(), 3);
  assert.ok(consoleErrors.some((line) => line.includes('[ALERT] telegram credentials rejected')));
  assert.equal(room.length, 1);
});

// ------------------------------------------------------------------ T-T20

for (const fault of ['http-429', 'http-500']) {
  test(`T-T20: Telegram ${fault}: transient, retried on the next round, delivered once`, async () => {
    const entry = agentEntry('telegram', `t20-${fault}`);
    const message = makeMessage(`tg ${fault}`);
    mock.inject('telegram', fault, 1);
    const started = Date.now();
    assert.equal((await deliver(entry, message)).pending, true);
    assert.equal(room.length, 0);
    assert.equal((await deliver(entry, message)).pending, false);
    await deliver(entry, message);
    assert.equal(tgSends(), 2, 'one failure + one success, never a duplicate');
    assert.ok(Date.now() - started < 3000);
  });
}

test('T-T20: Telegram 429 with retry_after: the bridge retries on the next round (round spacing = poll tick), not in-process', async () => {
  const entry = agentEntry('telegram', 't20-retry-after');
  const message = makeMessage('rate limited');
  mock.inject('telegram', 'http-429', 1); // mock answers retry_after = 1
  const started = Date.now();
  const first = await deliver(entry, message);
  const firstMs = Date.now() - started;
  assert.equal(first.pending, true);
  assert.ok(firstMs < 500, `outbound sendMessage does not sleep inside the request (${firstMs} ms)`);
  assert.equal(tgSends(), 1);
});

// ------------------------------------------------------------------ T-A05

async function sendCustomerMessage(id, text) {
  const sent = [];
  const original = facebook.sendMessage;
  facebook.sendMessage = async (psid, body) => { sent.push(body); };
  const started = Date.now();
  try {
    await indexModule.forwardToRocketChat('facebook', id, `FB ${id}`, text);
  } finally {
    facebook.sendMessage = original;
  }
  return { sent, elapsed: Date.now() - started };
}

for (const mode of ['http500', 'hang', 'garbage']) {
  test(`T-A05: AI ${mode === 'hang' ? 'timeout' : mode === 'http500' ? 'HTTP 500' : 'garbage reply'}: the message still reaches the agent and the customer sees no raw error`, async () => {
    ai.mode = mode;
    const { sent, elapsed } = await sendCustomerMessage(`a05-${mode}`, 'xin chao ban');
    assert.ok(room.includes('xin chao ban'), 'the customer message is in the room');
    assert.equal(ai.calls, 1);
    const toCustomer = sent.join('\n');
    assert.doesNotMatch(toCustomer, /sk-LEAKED|boom|upstream|AbortError|HTTP|\b500\b|stack|undefined/i, 'no raw error text for the customer');
    if (mode === 'hang') assert.ok(elapsed < 2000, `fell back after ${elapsed} ms (AI_TIMEOUT_MS=400)`);
    assert.ok(sent.every((text) => text === MESSAGES.ai.handoffDefault), 'the only thing the customer may see is the polite handoff notice');
    assert.doesNotMatch(consoleErrors.join('\n'), /sk-LEAKED-KEY/, 'the AI error body is not logged raw with the key');
  });
}

test('T-A05: with the AI declining, the customer gets exactly one polite handoff notice', async () => {
  ai.mode = 'decline';
  const { sent } = await sendCustomerMessage('a05-decline', 'toi can nguoi that');
  assert.equal(sent.length, 1);
  assert.ok(room.includes('toi can nguoi that'));
});

// ------------------------------------------------------------------ T-S06

test('T-S06: a customer spamming 100 messages gets 20 through, one notice, and the AI is called at most 20 times', async () => {
  ai.mode = 'answer';
  const sent = [];
  const original = facebook.sendMessage;
  facebook.sendMessage = async (psid, body) => { sent.push(body); };
  try {
    for (let i = 0; i < 100; i += 1) {
      await indexModule.forwardToRocketChat('facebook', 's06-spammer', 'FB s06-spammer', `spam ${i}`);
    }
    assert.equal(ai.calls, 20, 'AI is not charged for dropped messages');
    assert.equal(room.filter((text) => /^spam \d+$/.test(text)).length, 20);
    assert.equal(sent.filter((text) => text === MESSAGES.routing.rateLimited).length, 1, 'told exactly once');
    assert.equal(sent.filter((text) => text === 'AI says hi').length, 20);

    // An innocent customer at the same moment is unaffected.
    await indexModule.forwardToRocketChat('facebook', 's06-other', 'FB s06-other', 'normal message');
    assert.ok(room.includes('normal message'));
    assert.equal(ai.calls, 21);
  } finally {
    facebook.sendMessage = original;
  }
});

// ------------------------------------------------------------------ T-H06

function loadInChild(file) {
  const script = `
    const mapping = require(${JSON.stringify(path.resolve(__dirname, '../src/core/mapping.js'))});
mapping.load();
    const entry = mapping.getOrCreate('facebook', 'after-restart');
    console.log(JSON.stringify({ ok: true, found: Boolean(mapping.findByPlatformUser('facebook', 'after-restart')) }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, MAPPING_FILE: file },
    encoding: 'utf8',
    timeout: 15000,
  });
  return result;
}

for (const [label, content] of [
  ['truncated JSON', '{"entries":[{"platform":"facebook","platformUserId":"1","visitorTok'],
  ['empty file', ''],
  ['binary garbage', '\u0000\u0001\u0002not json'],
  ['JSON null', 'null'],
]) {
  test(`T-H06: mapping.json is ${label}: the bridge starts, warns, and keeps the unreadable file for recovery`, () => {
    const file = tmp(`h06-${label.replace(/\W+/g, '-')}.json`);
    fs.writeFileSync(file, content);
    const result = loadInChild(file);
    assert.equal(result.status, 0, `startup must not crash: ${result.stderr}`);
    assert.match(result.stdout, /"ok":true,"found":true/);
    assert.match(result.stderr, /Failed to load mapping file/, 'clear warning');
    const backups = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(path.basename(file) + '.corrupt-'));
    assert.equal(backups.length, 1, 'the corrupt file is preserved, not overwritten');
    assert.equal(fs.readFileSync(path.join(os.tmpdir(), backups[0]), 'utf8'), content);
    // The new mapping.json is valid JSON.
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
  });
}

test('T-H06: a failed write leaves the previous mapping.json intact and no temp file behind', () => {
  const file = tmp('h06-write.json');
  const script = `
    const fs = require('fs');
    const mapping = require(${JSON.stringify(path.resolve(__dirname, '../src/core/mapping.js'))});
mapping.load();
    mapping.getOrCreate('telegram', 'kept');
    const rename = fs.renameSync;
    fs.renameSync = () => { throw new Error('disk full (simulated)'); };
    let failed = false;
    try { mapping.getOrCreate('telegram', 'lost'); } catch { failed = true; }
    fs.renameSync = rename;
    console.log(JSON.stringify({ failed }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, MAPPING_FILE: file }, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"failed":true/);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk.entries.map((e) => e.platformUserId), ['kept']);
  const leftovers = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(path.basename(file)) && name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

// ------------------------------------------------------------------ T-H09

test('T-H09: SIGTERM with queued Facebook work finishes every acknowledged message before exiting', async () => {
  const delivered = [];
  rocketchat.sendMessageToRocketChat = async (token, roomId, text) => {
    await delay(250);
    delivered.push(text);
    return { success: true };
  };
  rocketchat.loginAgent = async () => ({ authToken: 'x', userId: 'y' });
  ai.mode = 'decline';
  const aiWas = process.env.AI_ENABLED;

  const realExit = process.exit;
  const realSetInterval = global.setInterval;
  const before = process.listeners('SIGTERM');
  const exitCodes = [];
  const exited = new Promise((resolve) => {
    process.exit = (code) => { exitCodes.push(code); resolve(code); };
  });
  global.setInterval = (...args) => { const timer = realSetInterval(...args); if (timer.unref) timer.unref(); return timer; };

  try {
    await indexModule.start();
    global.setInterval = realSetInterval;
    const handler = process.listeners('SIGTERM').find((fn) => !before.includes(fn));
    assert.ok(handler, 'start() registers a SIGTERM handler');

    const body = JSON.stringify({
      object: 'page',
      entry: [{
        messaging: [
          { sender: { id: 'h09-a' }, message: { mid: 'h09-1', text: 'a1' } },
          { sender: { id: 'h09-a' }, message: { mid: 'h09-2', text: 'a2' } },
          { sender: { id: 'h09-a' }, message: { mid: 'h09-3', text: 'a3' } },
          { sender: { id: 'h09-b' }, message: { mid: 'h09-4', text: 'b1' } },
        ],
      }],
    });
    const signature = `sha256=${crypto.createHmac('sha256', 'auto-del-app-secret').update(body).digest('hex')}`;
    const ack = await fetch(`http://127.0.0.1:${appPort}/webhook/facebook`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body,
    });
    assert.equal(ack.status, 200);
    assert.ok(delivered.length < 4, 'work is still queued when the signal arrives');

    const startedAt = Date.now();
    handler('SIGTERM');
    const code = await exited;
    const drainMs = Date.now() - startedAt;

    assert.equal(code, 0, 'clean exit code');
    assert.deepEqual(delivered.filter((text) => !text.startsWith('🤖')).sort(), ['a1', 'a2', 'a3', 'b1'], 'every acknowledged message was delivered before exit');
    assert.ok(drainMs >= 400, `the exit waited for the queue (${drainMs} ms)`);
    const stored = mapping.findByPlatformUser('facebook', 'h09-a');
    assert.deepEqual(stored.processedInboundIds, ['h09-1:text', 'h09-2:text', 'h09-3:text'], 'dedupe state saved, so a restart will not resend');

    // The listener is closed: new connections are refused.
    await delay(50);
    const refused = await new Promise((resolve) => {
      const socket = net.connect(appPort, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => resolve(true));
    });
    assert.equal(refused, true, 'the server stopped accepting connections');
  } finally {
    process.exit = realExit;
    global.setInterval = realSetInterval;
    process.env.AI_ENABLED = aiWas;
    for (const fn of process.listeners('SIGTERM')) if (!before.includes(fn)) process.removeListener('SIGTERM', fn);
    for (const fn of process.listeners('SIGINT')) if (fn.name === '' || fn.toString().includes("shutdown('SIGINT')")) process.removeListener('SIGINT', fn);
  }
});
