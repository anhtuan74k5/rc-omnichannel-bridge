const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchWithTimeout } = require('../httpClient');
const { mask } = require('../logger');

test('mask hides URL and credential secrets', () => {
  const value = mask('https://api.telegram.org/bot123:secret/sendMessage?token=visitor_abc&access_token=fb-secret');
  assert.equal(value, 'https://api.telegram.org/bot***/sendMessage?token=***&access_token=***');
  assert.deepEqual(mask({ 'X-Auth-Token': 'secret', password: 'secret', visitorToken: 'visitor_1' }), {
    'X-Auth-Token': '***',
    password: '***',
    visitorToken: '***',
  });
});

test('fetchWithTimeout retries retryable HTTP responses', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(calls === 1 ? 'busy' : 'ok', { status: calls === 1 ? 503 : 200 });
  };

  try {
    const response = await fetchWithTimeout('https://example.test', {}, { retries: 1 });
    assert.equal(calls, 2);
    assert.equal(response.status, 200);
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchWithTimeout respects Telegram retry_after on 429', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        ok: false,
        error_code: 429,
        parameters: { retry_after: 1 },
      }), { status: 429 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    const startedAt = Date.now();
    const response = await fetchWithTimeout(
      'https://api.telegram.org/botmasked/getUpdates',
      {},
      { retries: 1 }
    );
    const elapsedMs = Date.now() - startedAt;

    assert.equal(calls, 2);
    assert.equal(response.status, 200);
    assert.ok(elapsedMs >= 1000, `expected at least 1000ms delay, got ${elapsedMs}ms`);
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchWithTimeout does not retry POST by default', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response('busy', { status: 503 });
  };

  try {
    const response = await fetchWithTimeout('https://example.test', { method: 'POST' }, { retries: 2 });
    assert.equal(calls, 1);
    assert.equal(response.status, 503);
  } finally {
    global.fetch = originalFetch;
  }
});
