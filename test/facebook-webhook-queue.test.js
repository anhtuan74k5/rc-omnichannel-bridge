const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// Isolate from the developer's real .env and mapping.json.
const mappingFile = path.join(os.tmpdir(), `fb-queue-mapping-${process.pid}.json`);
process.env.MAPPING_FILE = mappingFile;
process.env.AI_ENABLED = 'false';
process.env.FB_APP_SECRET = 'queue-test-secret';
process.env.FB_PAGE_ACCESS_TOKEN = 'queue-test-token';

const mapping = require('../mapping');
const rocketchat = require('../rocketchat');
const { app, facebookQueue } = require('../index');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function signed(payload) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${crypto.createHmac('sha256', 'queue-test-secret').update(body).digest('hex')}`;
  return { body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature } };
}

function message(psid, mid, text) {
  return { sender: { id: psid }, message: { mid, text } };
}

async function startServer(t) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/webhook/facebook`;
}

test('webhook is acknowledged before slow processing finishes; order and dedupe hold', async (t) => {
  t.after(() => { try { fs.unlinkSync(mappingFile); } catch { /* already gone */ } });

  const original = {
    getOrCreateVisitor: rocketchat.getOrCreateVisitor,
    getOrCreateRoom: rocketchat.getOrCreateRoom,
    sendMessageToRocketChat: rocketchat.sendMessageToRocketChat,
  };
  t.after(() => Object.assign(rocketchat, original));

  const delivered = [];
  rocketchat.getOrCreateVisitor = async (id) => `visitor_${id}`;
  rocketchat.getOrCreateRoom = async () => 'room-1';
  rocketchat.sendMessageToRocketChat = async (token, roomId, text) => {
    await delay(300); // slow Rocket.Chat / AI
    delivered.push(text);
    return { success: true };
  };

  mapping.load();
  const url = await startServer(t);
  const payload = signed({
    object: 'page',
    entry: [{ messaging: [message('u-1', 'mid-1', 'first'), message('u-1', 'mid-2', 'second')] }],
  });

  const started = Date.now();
  const res = await fetch(url, { method: 'POST', headers: payload.headers, body: payload.body });
  const ackMs = Date.now() - started;
  assert.equal(res.status, 200);
  // The invariant is "200 before the work is done" (checked by delivered.length below);
  // the time bound is only a sanity check and is loose so a loaded CI/PC does not flake.
  assert.ok(ackMs < 550, `acknowledged in ${ackMs} ms; should not wait for the 600 ms of work`);
  assert.equal(delivered.length, 0, 'work must still be pending when the 200 is returned');

  assert.equal(await facebookQueue.idle(5000), true);
  assert.deepEqual(delivered, ['first', 'second'], 'messages keep arrival order');

  // Meta redelivers the same webhook (it did not see a fast answer): no duplicates.
  const retry = await fetch(url, { method: 'POST', headers: payload.headers, body: payload.body });
  assert.equal(retry.status, 200);
  assert.equal(await facebookQueue.idle(5000), true);
  assert.deepEqual(delivered, ['first', 'second'], 'redelivery must be ignored');

  const stored = mapping.findByPlatformUser('facebook', 'u-1');
  assert.deepEqual(stored.processedInboundIds, ['mid-1:text', 'mid-2:text']);
});

test('a redelivery that arrives while the first copy is still processing is ignored', async (t) => {
  const original = rocketchat.sendMessageToRocketChat;
  t.after(() => { rocketchat.sendMessageToRocketChat = original; });
  rocketchat.getOrCreateVisitor = async (id) => `visitor_${id}`;
  rocketchat.getOrCreateRoom = async () => 'room-2';

  const delivered = [];
  rocketchat.sendMessageToRocketChat = async (token, roomId, text) => {
    await delay(300);
    delivered.push(text);
    return { success: true };
  };

  mapping.load();
  const url = await startServer(t);
  const payload = signed({ object: 'page', entry: [{ messaging: [message('u-2', 'mid-9', 'once')] }] });

  await fetch(url, { method: 'POST', headers: payload.headers, body: payload.body });
  await delay(50); // first copy is mid-flight
  await fetch(url, { method: 'POST', headers: payload.headers, body: payload.body });

  assert.equal(await facebookQueue.idle(5000), true);
  assert.deepEqual(delivered, ['once']);
});

test('different customers are processed in parallel', async (t) => {
  rocketchat.getOrCreateVisitor = async (id) => `visitor_${id}`;
  rocketchat.getOrCreateRoom = async () => 'room-3';
  rocketchat.sendMessageToRocketChat = async () => {
    await delay(300);
    return { success: true };
  };

  mapping.load();
  const url = await startServer(t);
  const payload = signed({
    object: 'page',
    entry: [{ messaging: [message('p-1', 'mid-p1', 'a'), message('p-2', 'mid-p2', 'b'), message('p-3', 'mid-p3', 'c')] }],
  });

  const started = Date.now();
  await fetch(url, { method: 'POST', headers: payload.headers, body: payload.body });
  assert.equal(await facebookQueue.idle(5000), true);
  const total = Date.now() - started;
  assert.ok(total < 800, `three 300 ms jobs for three customers took ${total} ms; expected ~300 ms`);
});
