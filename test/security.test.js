const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

test('fake Telegram and Rocket.Chat servers exchange UTF-8 JSON and PDF media metadata', async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ url: req.url, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const telegramResponse = await fetch(`${base}/bot/test/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ chat_id: 'chat', text: 'Ảnh 📷' }),
  });
  const rocketChatResponse = await fetch(`${base}/api/v1/livechat/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: 'sample.pdf', mimeType: 'application/pdf' }),
  });

  assert.equal(telegramResponse.ok, true);
  assert.equal(rocketChatResponse.ok, true);
  assert.equal(JSON.parse(requests[0].body.toString('utf8')).text, 'Ảnh 📷');
  assert.equal(JSON.parse(requests[1].body.toString('utf8')).mimeType, 'application/pdf');
});
