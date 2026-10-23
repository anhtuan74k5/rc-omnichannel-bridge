const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyMime } = require('../media/mime');

test('classifyMime classifies supported media and fallbacks', () => {
  const cases = [
    ['image/png', 'x.png', 'image'],
    ['image/jpeg', 'x.jpg', 'image'],
    ['image/gif', 'x.gif', 'animation'],
    ['video/mp4', 'x.mp4', 'video'],
    ['video/webm', 'x.webm', 'video'],
    ['audio/ogg; codecs=opus', 'x.ogg', 'voice'],
    ['audio/mpeg', 'x.mp3', 'audio'],
    ['audio/mp4', 'x.m4a', 'audio'],
    ['application/pdf', 'x.pdf', 'document'],
    ['application/zip', 'x.zip', 'document'],
    ['application/x-unknown', 'x.mp4', 'video'],
    ['', 'x.png', 'image'],
    ['', 'x.bin', 'document'],
  ];
  for (const [mime, filename, expected] of cases) {
    assert.equal(classifyMime(mime, filename), expected, `${mime} ${filename}`);
  }
});

function response(ok = true, status = 200, body = { ok: true }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function descriptor(kind) {
  return { kind, filename: `${kind}.bin`, mimeType: 'application/octet-stream', size: 3, buffer: Buffer.from('abc'), source: 'test' };
}

test('sendMedia uses the endpoint and multipart field for every kind', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return response();
  };
  process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';
  const telegram = require('../telegram');
  const expected = {
    image: ['sendPhoto', 'photo'],
    document: ['sendDocument', 'document'],
    video: ['sendVideo', 'video'],
    audio: ['sendAudio', 'audio'],
    voice: ['sendVoice', 'voice'],
    animation: ['sendAnimation', 'animation'],
  };

  for (const [kind, [method, field]] of Object.entries(expected)) {
    await telegram.sendMedia('chat', descriptor(kind), 'caption');
    const formEntries = [...calls.at(-1).options.body.entries()];
    assert.equal(calls.at(-1).url.endsWith(`/${method}`), true);
    assert.equal(formEntries.find(([name]) => name === field)[0], field);
    assert.equal(formEntries.find(([name]) => name === 'chat_id')[1], 'chat');
  }
  assert.equal(calls.length, Object.keys(expected).length);
});

test('sendPhoto falls back to sendDocument on Telegram 400', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const urls = [];
  global.fetch = async (url) => {
    urls.push(url);
    return urls.length === 1 ? response(false, 400, { ok: false }) : response();
  };
  const telegram = require('../telegram');
  await telegram.sendPhoto('chat', descriptor('image'), 'caption');
  assert.equal(urls[0].endsWith('/sendPhoto'), true);
  assert.equal(urls[1].endsWith('/sendDocument'), true);
});

test('sendMedia sends caption remainder after the first 1024 characters', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const bodies = [];
  global.fetch = async (url, options) => {
    bodies.push({ url, body: options.body });
    return url.endsWith('/sendMessage') ? response() : response();
  };
  const telegram = require('../telegram');
  const caption = 'a'.repeat(1024) + 'tail';
  await telegram.sendMedia('chat', descriptor('document'), caption);
  const mediaEntries = [...bodies[0].body.entries()];
  assert.equal(mediaEntries.find(([name]) => name === 'caption')[1].length, 1024);
  assert.equal(bodies[1].url.endsWith('/sendMessage'), true);
  assert.equal(JSON.parse(bodies[1].body).text, 'tail');
});
