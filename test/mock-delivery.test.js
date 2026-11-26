const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const { createMock } = require('../scripts/e2e/mock-platforms');

const mock = createMock();
let facebook;
let telegram;
let classify;

test.before(async () => {
  const port = await mock.listen(0);
  process.env.FB_GRAPH_BASE_URL = `http://127.0.0.1:${port}/`;
  process.env.TELEGRAM_API_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.FB_PAGE_ACCESS_TOKEN = 'mock-page-token';
  process.env.TELEGRAM_BOT_TOKEN = '123:mock-bot-token';
  process.env.HTTP_TIMEOUT_MS = '300';
  process.env.MAPPING_FILE = path.join(os.tmpdir(), `mock-map-${process.pid}.json`);
  // Required only after the env above is set (config reads it at load time).
  facebook = require('../src/platforms/facebook');
  telegram = require('../src/platforms/telegram');
  classify = require('../src/core/deliveryErrors').classifyDeliveryError;
});
test.after(() => mock.close());
test.beforeEach(() => mock.clear());

async function failure(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  return assert.fail('expected the call to fail');
}

test('base URLs are overridable and trailing slash trimmed', () => {
  const { API } = require('../src/constants/config');
  assert.match(API.facebook.graphBaseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(API.telegram.fileBaseUrl, `${API.telegram.baseUrl}/file`);
});

test('facebook success reaches the mock', async () => {
  const data = await facebook.sendMessage('PSID', 'hello');
  assert.match(data.message_id, /^m_mock_/);
  assert.equal(mock.requests[0].route, 'me/messages');
});

const FB_CASES = [
  ['fb-190', 'auth'],
  ['fb-551', 'permanent'],
  ['fb-10', 'permanent'],
  ['fb-2018278', 'permanent'],
  ['fb-100', 'permanent'],
  ['fb-rate', 'transient'],
  ['http-429', 'transient'],
  ['http-500', 'transient'],
  ['http-503', 'transient'],
];
for (const [fault, kind] of FB_CASES) {
  test(`facebook ${fault} is classified ${kind}`, async () => {
    mock.inject('facebook', fault);
    const error = await failure(() => facebook.sendMessage('PSID', 'hi'));
    assert.equal(classify('facebook', error).kind, kind);
  });
}

test('facebook timeout is transient (network)', async () => {
  mock.inject('facebook', 'timeout');
  const error = await failure(() => facebook.sendMessage('PSID', 'hi'));
  assert.equal(classify('facebook', error).kind, 'transient');
});

const TG_CASES = [
  ['tg-401', 'auth'],
  ['tg-403', 'permanent'],
  ['tg-400-parse', 'permanent'],
  ['http-429', 'transient'],
  ['http-500', 'transient'],
];
for (const [fault, kind] of TG_CASES) {
  test(`telegram ${fault} is classified ${kind}`, async () => {
    mock.inject('telegram', fault);
    const error = await failure(() => telegram.sendMessage(42, 'hi'));
    assert.equal(classify('telegram', error).kind, kind);
  });
}

test('telegram timeout is transient (network)', async () => {
  mock.inject('telegram', 'timeout');
  const error = await failure(() => telegram.sendMessage(42, 'hi'));
  assert.equal(classify('telegram', error).kind, 'transient');
});

test('facebook checkToken: ok, invalid, expiring, unreachable never throw', async () => {
  assert.equal((await facebook.checkToken()).status, 'ok');

  mock.inject('facebook', 'fb-190');
  assert.equal((await facebook.checkToken()).status, 'invalid');

  // /me succeeds, debug_token reports an expiry within an hour.
  mock.clear();
  mock.inject('facebook', 'ok-token-expiring', 0);
  assert.equal((await facebook.checkToken()).status, 'expiring');

  mock.clear();
  mock.inject('facebook', 'timeout');
  assert.equal((await facebook.checkToken()).status, 'unreachable');
});

test('facebook checkToken warns before Meta data access ends, even for a never-expiring token', async () => {
  mock.clear();
  const ok = await facebook.checkToken();
  assert.equal(ok.status, 'ok');
  assert.ok(ok.dataAccessExpiresAt > 0, 'data access date is read');

  mock.clear();
  mock.inject('facebook', 'ok-data-access-expiring', 0);
  const soon = await facebook.checkToken();
  assert.equal(soon.status, 'data-access-expiring');
  assert.equal(soon.expiresAt, 0, 'the token itself never expires');
  mock.clear();
});

test('Messenger read receipts and delivery reports are not logged at the normal level', async () => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  try {
    delete process.env.LOG_LEVEL;
    await facebook.handleWebhook({
      object: 'page',
      entry: [{ messaging: [
        { sender: { id: 'P1' }, recipient: { id: 'PAGE' }, read: { watermark: 1 } },
        { sender: { id: 'P1' }, recipient: { id: 'PAGE' }, delivery: { watermark: 1 } },
        { sender: { id: 'P1' }, recipient: { id: 'PAGE' }, message: { mid: 'm1', is_echo: true, text: 'x' } },
        { sender: { id: 'P1' }, recipient: { id: 'PAGE' }, postback: { payload: 'GET_STARTED' } },
      ] }],
    }, async () => {});
  } finally {
    console.log = original;
  }
  assert.equal(lines.filter((l) => l.includes('routine')).length, 0, 'receipts and echoes stay quiet');
  const unsupported = lines.filter((l) => l.includes('unsupported event'));
  assert.equal(unsupported.length, 1, 'an unknown event type is still visible');
  assert.match(unsupported[0], /postback/);
});

test('telegram checkToken: ok, invalid, unreachable never throw', async () => {
  const ok = await telegram.checkToken();
  assert.equal(ok.status, 'ok');
  assert.equal(ok.username, 'mock_bot');

  mock.inject('telegram', 'tg-401');
  assert.equal((await telegram.checkToken()).status, 'invalid');

  mock.inject('telegram', 'timeout');
  assert.equal((await telegram.checkToken()).status, 'unreachable');
});

test('token check logs never contain the token', async () => {
  const lines = [];
  const original = { log: console.log, warn: console.warn };
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    mock.inject('telegram', 'tg-401');
    await telegram.checkToken();
    mock.inject('facebook', 'fb-190');
    await facebook.checkToken();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
  }
  assert.ok(lines.length >= 2);
  assert.ok(!lines.join('\n').includes('mock-bot-token'));
  assert.ok(!lines.join('\n').includes('mock-page-token'));
});
