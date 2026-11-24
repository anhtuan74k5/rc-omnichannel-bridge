const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');

// Isolate from the developer's real .env and mapping.json.
process.env.AI_ENABLED = 'false';
process.env.MAPPING_FILE = require('path').join(require('os').tmpdir(), `fb-test-mapping-${process.pid}.json`);
process.env.FB_APP_SECRET = 'test-app-secret';
process.env.FB_PAGE_ACCESS_TOKEN = 'test-page-token';
process.env.FB_VERIFY_TOKEN = 'test-verify';

const facebook = require('../facebook');
const { app } = require('../index');
const { downloadFacebookAttachment, isAllowedFacebookMediaUrl } = require('../media/facebookFiles');

function sign(body, secret = 'test-app-secret') {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('verifySignature accepts only the correct HMAC of the raw body', () => {
  const raw = Buffer.from('{"object":"page"}');
  assert.equal(facebook.verifySignature(raw, sign(raw)), true);
  assert.equal(facebook.verifySignature(raw, sign(raw, 'other-secret')), false);
  assert.equal(facebook.verifySignature(raw, sign(Buffer.from('tampered'))), false);
  assert.equal(facebook.verifySignature(raw, ''), false);
  assert.equal(facebook.verifySignature(raw, 'sha256=zz'), false);
  assert.equal(facebook.verifySignature(raw, undefined), false);
  assert.equal(facebook.verifySignature(undefined, sign(raw)), false);
  assert.equal(facebook.verifySignature(raw, sign(raw), ''), false);
});

test('POST /webhook/facebook rejects unsigned or badly signed requests with 401', async (t) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/webhook/facebook`;
  const body = JSON.stringify({ object: 'page', entry: [] });

  const unsigned = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(unsigned.status, 401);

  const wrong = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body, 'nope') },
    body,
  });
  assert.equal(wrong.status, 401);

  const valid = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
    body,
  });
  assert.equal(valid.status, 200);
});

test('GET /webhook/facebook echoes the challenge only for the right verify token', async (t) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/webhook/facebook`;

  const ok = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=abc123`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'abc123');

  const bad = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123`);
  assert.equal(bad.status, 403);
});

test('handleWebhook dispatches text and every attachment, and skips echoes', async () => {
  const texts = [];
  const attachments = [];
  await facebook.handleWebhook({
    object: 'page',
    entry: [{
      messaging: [
        { sender: { id: 'u1' }, message: { text: 'hello' } },
        { sender: { id: 'u1' }, message: { attachments: [
          { type: 'image', payload: { url: 'https://scontent.xx.fbcdn.net/a.jpg' } },
          { type: 'file', payload: { url: 'https://cdn.fbsbx.com/b.pdf' } },
        ] } },
        { sender: { id: 'page' }, message: { is_echo: true, text: 'echo' } },
        { sender: { id: 'u2' }, postback: { payload: 'x' } },
      ],
    }],
  }, async (psid, text) => texts.push([psid, text]), async (psid, att) => attachments.push([psid, att.type]));

  assert.deepEqual(texts, [['u1', 'hello']]);
  assert.deepEqual(attachments, [['u1', 'image'], ['u1', 'file']]);
});

test('only https Facebook CDN hosts are downloadable', () => {
  assert.equal(isAllowedFacebookMediaUrl('https://scontent-sin6-1.xx.fbcdn.net/v/a.jpg'), true);
  assert.equal(isAllowedFacebookMediaUrl('https://lookaside.fbsbx.com/file.pdf'), true);
  assert.equal(isAllowedFacebookMediaUrl('http://scontent.xx.fbcdn.net/a.jpg'), false);
  assert.equal(isAllowedFacebookMediaUrl('https://evil.example.com/a.jpg'), false);
  assert.equal(isAllowedFacebookMediaUrl('https://fbcdn.net.evil.com/a.jpg'), false);
  assert.equal(isAllowedFacebookMediaUrl('http://169.254.169.254/latest'), false);
  assert.equal(isAllowedFacebookMediaUrl('not a url'), false);
});

test('downloadFacebookAttachment rejects bad hosts, enforces size, derives name and mime', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return new Response(Buffer.from('abcd'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  };

  await assert.rejects(downloadFacebookAttachment('https://evil.example.com/x.jpg'), /not an allowed/);
  assert.equal(calls.length, 0);

  const file = await downloadFacebookAttachment('https://scontent.xx.fbcdn.net/v/abc.jpg?sig=1');
  assert.equal(file.filename, 'abc.jpg');
  assert.equal(file.mimeType, 'image/jpeg');
  assert.equal(file.size, 4);

  const nameless = await downloadFacebookAttachment('https://scontent.xx.fbcdn.net/v/abc', { fallbackName: 'image_1' });
  assert.equal(nameless.filename, 'image_1.jpg');

  await assert.rejects(
    downloadFacebookAttachment('https://scontent.xx.fbcdn.net/v/abc.jpg', { maxBytes: 2 }),
    (err) => err.code === 'FACEBOOK_FILE_TOO_LARGE'
  );
});

test('sendMessage and sendMedia use the Authorization header, never the URL', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ recipient_id: 'u1', message_id: 'm1' });
  };

  await facebook.sendMessage('u1', 'hi');
  await facebook.sendMedia('u1', {
    kind: 'voice', filename: 'v.ogg', mimeType: 'audio/ogg', buffer: Buffer.from('abc'),
  });

  for (const call of calls) {
    assert.ok(!call.url.includes('access_token'), call.url);
    assert.ok(!call.url.includes('test-page-token'), call.url);
    assert.equal(call.options.headers.Authorization, 'Bearer test-page-token');
    assert.match(call.url, /\/me\/messages$/);
  }

  assert.deepEqual(JSON.parse(calls[0].options.body).recipient, { id: 'u1' });
  const form = calls[1].options.body;
  assert.ok(form instanceof FormData);
  assert.deepEqual(JSON.parse(form.get('message')), { attachment: { type: 'audio', payload: { is_reusable: false } } });
  assert.equal(form.get('filedata').name, 'v.ogg');
});

test('toAttachmentType maps bridge kinds to Messenger types', () => {
  const expected = { image: 'image', animation: 'image', video: 'video', audio: 'audio', voice: 'audio', document: 'file' };
  for (const [kind, type] of Object.entries(expected)) {
    assert.equal(facebook.toAttachmentType(kind), type, kind);
  }
});

test('sendMedia and sendMessage surface Graph API errors', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => jsonResponse({ error: { message: 'bad', code: 100 } }, 400);

  await assert.rejects(facebook.sendMessage('u1', 'hi'), /Facebook send failed \(400\)/);
  await assert.rejects(
    facebook.sendMedia('u1', { kind: 'image', buffer: Buffer.from('x'), filename: 'a.png', mimeType: 'image/png' }),
    /Facebook send failed \(400\)/
  );
  await assert.rejects(facebook.sendMedia('u1', { kind: 'image', buffer: Buffer.alloc(0) }), /non-empty Buffer/);
});
