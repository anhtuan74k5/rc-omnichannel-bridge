const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';

const telegram = require('../telegram');

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function mockFetch(t, handler) {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    const call = { url, body: typeof options.body === 'string' ? JSON.parse(options.body) : options.body };
    calls.push(call);
    return handler(call, calls.length);
  };
  t.after(() => { global.fetch = originalFetch; });
  return calls;
}

test('sendMessage defaults to verbatim plain text (bridge, system and AI messages)', async (t) => {
  const calls = mockFetch(t, () => jsonResponse(200, { ok: true }));
  await telegram.sendMessage(1, 'file_name_v2.pdf **kept** <b>raw</b>');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { chat_id: 1, text: 'file_name_v2.pdf **kept** <b>raw</b>' });
});

test('sendMessage with markdown sends HTML parse_mode for agent text', async (t) => {
  const calls = mockFetch(t, () => jsonResponse(200, { ok: true }));
  await telegram.sendMessage(1, '**đậm** __nghiêng__ ~~gạch~~ `code`', { markdown: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.parse_mode, 'HTML');
  assert.equal(calls[0].body.text, '<b>đậm</b> <i>nghiêng</i> <s>gạch</s> <code>code</code>');
});

test('sendMessage with markdown omits parse_mode when there is no formatting', async (t) => {
  const calls = mockFetch(t, () => jsonResponse(200, { ok: true }));
  await telegram.sendMessage(1, 'a < b && c > d', { markdown: true });
  assert.deepEqual(calls[0].body, { chat_id: 1, text: 'a < b && c > d' });
});

test('sendMessage resends plain text once when Telegram rejects the entities', async (t) => {
  const calls = mockFetch(t, (call, n) => (n === 1
    ? jsonResponse(400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities: Unmatched end tag at byte offset 3" })
    : jsonResponse(200, { ok: true })));
  await telegram.sendMessage(1, '**hi**', { markdown: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.parse_mode, 'HTML');
  assert.deepEqual(calls[1].body, { chat_id: 1, text: '**hi**' });
});

test('sendMessage does not retry unrelated 400 errors', async (t) => {
  const calls = mockFetch(t, () => jsonResponse(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }));
  await assert.rejects(() => telegram.sendMessage(1, '**hi**', { markdown: true }), (error) => {
    assert.equal(error.status, 400);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('media captions render markdown and fall back to plain text on entity errors', async (t) => {
  const calls = mockFetch(t, (call, n) => (n === 1
    ? jsonResponse(400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities" })
    : jsonResponse(200, { ok: true })));
  const descriptor = { kind: 'document', filename: 'a.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('abc') };

  await telegram.sendMedia(1, descriptor, '**cap**', { markdown: true });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.get('caption'), '<b>cap</b>');
  assert.equal(calls[0].body.get('parse_mode'), 'HTML');
  assert.equal(calls[1].body.get('caption'), '**cap**');
  assert.equal(calls[1].body.has('parse_mode'), false);
});

test('media captions stay verbatim without the markdown option', async (t) => {
  const calls = mockFetch(t, () => jsonResponse(200, { ok: true }));
  const descriptor = { kind: 'document', filename: 'a.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('abc') };

  await telegram.sendMedia(1, descriptor, '**cap**');

  assert.equal(calls[0].body.get('caption'), '**cap**');
  assert.equal(calls[0].body.has('parse_mode'), false);
});
