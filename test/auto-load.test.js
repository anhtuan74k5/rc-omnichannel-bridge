/**
 * Automated matrix: T-P01 (100 sequential messages) and T-P02 (20 customers x 5 messages).
 * Rocket.Chat is an in-process stub with a small fixed latency; the Messenger webhook is the real route.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const mappingFile = path.join(os.tmpdir(), `auto-load-mapping-${process.pid}.json`);
process.env.MAPPING_FILE = mappingFile;
process.env.AI_ENABLED = 'false';
process.env.RATE_LIMIT_PER_MINUTE = '0'; // the limiter is covered by T-S06
process.env.FB_APP_SECRET = 'auto-load-secret';
process.env.FB_PAGE_ACCESS_TOKEN = 'auto-load-token';
process.env.FB_GRAPH_BASE_URL = 'http://127.0.0.1:9'; // profile lookups fail fast, never reach Meta
process.env.ROCKETCHAT_URL = 'http://rocketchat.invalid';

const mapping = require('../src/core/mapping');
const rocketchat = require('../src/rocketchat/rocketchat');
const { app, facebookQueue } = require('..');

const RC_LATENCY_MS = 20;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

const delivered = []; // { user, text, at }
let url;
let server;
const originals = {};

test.before(async () => {
  mapping.load();
  for (const name of ['getOrCreateVisitor', 'getOrCreateRoom', 'sendMessageToRocketChat']) originals[name] = rocketchat[name];
  rocketchat.getOrCreateVisitor = async (id) => `visitor_${id}`;
  rocketchat.getOrCreateRoom = async (token) => `room_${token}`;
  rocketchat.sendMessageToRocketChat = async (token, roomId, text) => {
    await delay(RC_LATENCY_MS);
    delivered.push({ user: token.replace('visitor_', ''), text, at: performance.now() });
    return { success: true };
  };
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/webhook/facebook`;
});
test.after(() => {
  Object.assign(rocketchat, originals);
  server.close();
  try { fs.unlinkSync(mappingFile); } catch { /* gone */ }
});
test.beforeEach(() => { delivered.length = 0; });

function postMessage(psid, mid, text) {
  const body = JSON.stringify({ object: 'page', entry: [{ messaging: [{ sender: { id: psid }, message: { mid, text } }] }] });
  const signature = `sha256=${crypto.createHmac('sha256', 'auto-load-secret').update(body).digest('hex')}`;
  const sentAt = performance.now();
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body })
    .then((res) => ({ status: res.status, sentAt, ackMs: performance.now() - sentAt }));
}

async function waitFor(predicate, timeoutMs = 20000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for delivery');
    await delay(2);
  }
}

test('T-P01: 100 sequential messages from one customer arrive in order, none lost or duplicated', async (t) => {
  const latencies = [];
  const acks = [];
  for (let i = 0; i < 100; i += 1) {
    const sent = await postMessage('p01-user', `mid-p01-${i}`, `msg ${i}`);
    assert.equal(sent.status, 200);
    acks.push(sent.ackMs);
    await waitFor(() => delivered.length === i + 1);
    latencies.push(delivered[i].at - sent.sentAt);
  }
  assert.equal(await facebookQueue.idle(5000), true);
  assert.deepEqual(delivered.map((d) => d.text), Array.from({ length: 100 }, (_, i) => `msg ${i}`), 'exact order, no loss, no duplicates');

  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  t.diagnostic(`PERF T-P01 end-to-end (POST -> room, stub RC ${RC_LATENCY_MS} ms): p50=${p50.toFixed(1)} ms p95=${p95.toFixed(1)} ms max=${Math.max(...latencies).toFixed(1)} ms; webhook ack p50=${percentile(acks, 50).toFixed(1)} ms p95=${percentile(acks, 95).toFixed(1)} ms`);
  assert.ok(p95 < 500, `p95 ${p95.toFixed(1)} ms`);
  assert.ok(percentile(acks, 95) < 100, 'the webhook is acknowledged quickly regardless of processing time');
});

test('T-P02: 20 customers x 5 messages sent concurrently keep per-customer order, no loss, no duplicates', async (t) => {
  const customers = Array.from({ length: 20 }, (_, i) => `p02-user-${i}`);
  const sentAt = new Map();
  const acks = [];

  // Each customer fires its 5 messages back to back; the 20 customers run at the same time.
  await Promise.all(customers.map(async (psid) => {
    for (let n = 0; n < 5; n += 1) {
      const text = `${psid}#${n}`;
      const sent = await postMessage(psid, `mid-${psid}-${n}`, text);
      assert.equal(sent.status, 200);
      sentAt.set(text, sent.sentAt);
      acks.push(sent.ackMs);
    }
  }));
  await waitFor(() => delivered.length === 100);
  assert.equal(await facebookQueue.idle(10000), true);

  assert.equal(delivered.length, 100, 'nothing lost');
  assert.equal(new Set(delivered.map((d) => d.text)).size, 100, 'nothing duplicated');
  for (const psid of customers) {
    const order = delivered.filter((d) => d.user === psid).map((d) => d.text);
    assert.deepEqual(order, [0, 1, 2, 3, 4].map((n) => `${psid}#${n}`), `${psid}: arrival order kept`);
  }
  // Customers never see each other's messages in their room.
  assert.ok(delivered.every((d) => d.text.startsWith(d.user)), 'no cross-customer mixing');

  const latencies = delivered.map((d) => d.at - sentAt.get(d.text));
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  t.diagnostic(`PERF T-P02 end-to-end (100 msgs, 20 customers in parallel): p50=${p50.toFixed(1)} ms p95=${p95.toFixed(1)} ms max=${Math.max(...latencies).toFixed(1)} ms; webhook ack p50=${percentile(acks, 50).toFixed(1)} ms p95=${percentile(acks, 95).toFixed(1)} ms`);
  assert.ok(p95 < 2000, `p95 ${p95.toFixed(1)} ms`);
});
