const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-api-'));
const shared = path.join(dir, 'shared');
const outside = path.join(dir, 'secret.txt');
fs.mkdirSync(shared);
fs.writeFileSync(outside, 'not yours');
const document = path.join(shared, 'big.bin');
fs.writeFileSync(document, Buffer.alloc(64, 1));

process.env.TELEGRAM_BOT_TOKEN = '1:local';
process.env.TELEGRAM_LOCAL_FILES_DIR = shared;
delete process.env.TELEGRAM_MAX_MEDIA_BYTES;

const { ENV } = require('../src/constants/config');
const { downloadTelegramFile, isTelegramFileTooLarge } = require('../src/media/telegramFiles');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function serverReturns(t, filePath) {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const asked = [];
  global.fetch = async (url) => {
    asked.push(String(url));
    return new Response(JSON.stringify({ ok: true, result: { file_path: filePath } }));
  };
  return asked;
}

test('a local server raises the default limit above the cloud 20 MB', () => {
  assert.equal(ENV.telegramMaxMediaBytes, 100 * 1024 * 1024);
});

test('a file in the shared folder is read from disk', async (t) => {
  const asked = serverReturns(t, document);
  const file = await downloadTelegramFile('f');
  assert.equal(file.size, 64);
  assert.equal(asked.length, 1, 'only getFile goes over HTTP');
});

test('paths outside the shared folder are never opened', async (t) => {
  for (const bad of [outside, path.join(shared, '..', 'secret.txt')]) {
    serverReturns(t, bad);
    await assert.rejects(downloadTelegramFile('f'), /outside TELEGRAM_LOCAL_FILES_DIR/);
  }
});

test('size limit applies, and errors never quote the path', async (t) => {
  serverReturns(t, document);
  await assert.rejects(downloadTelegramFile('f', { maxBytes: 10 }), isTelegramFileTooLarge);
  serverReturns(t, path.join(shared, '1:local', 'missing.bin'));
  await assert.rejects(downloadTelegramFile('f'), (error) => {
    assert.match(error.message, /ENOENT/);
    return !error.message.includes('1:local');
  });
});
