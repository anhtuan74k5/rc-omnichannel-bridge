/**
 * Mock of the Facebook Graph API and Telegram Bot API with fault injection.
 *
 *   node scripts/e2e/mock-platforms.js [port]       (default 4010)
 *   FB_GRAPH_BASE_URL=http://127.0.0.1:4010  TELEGRAM_API_BASE_URL=http://127.0.0.1:4010
 *
 * Both platforms share one port: Graph paths start with /v<N>.<N>/, Telegram
 * paths with /bot<token>/. Nothing is sent to real services.
 *
 * Faults (queue per platform; count=0 means sticky until cleared):
 *   POST /__fault  {"platform":"facebook|telegram","fault":"<name>","count":1}
 *   DELETE /__fault           clears all faults
 *   GET  /__requests          requests received so far (no tokens, no bodies)
 * Fault names: fb-190, fb-551, fb-10, fb-2018278, fb-100, fb-rate (code 4),
 *   http-429, http-500, http-503, tg-401, tg-403, tg-400-chat, tg-400-parse,
 *   timeout (never answers), ok-token-expiring (debug_token expires in 1 h).
 */

const http = require('http');

const FAULTS = {
  'fb-190': () => [401, { error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } }],
  'fb-551': () => [400, { error: { message: "This person isn't available right now.", code: 551, error_subcode: 1545041 } }],
  'fb-10': () => [400, { error: { message: 'Outside of allowed window', code: 10, error_subcode: 2018278 } }],
  'fb-2018278': () => [400, { error: { message: 'Outside of allowed window', code: 100, error_subcode: 2018278 } }],
  'fb-100': () => [400, { error: { message: 'Invalid parameter', code: 100 } }],
  'fb-rate': () => [400, { error: { message: 'Rate limited', code: 4 } }],
  'http-429': (platform) => [429, platform === 'telegram'
    ? { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } }
    : { error: { message: 'Too many calls', code: 613 } }],
  'http-500': (platform) => [500, platform === 'telegram'
    ? { ok: false, error_code: 500, description: 'Internal Server Error' }
    : { error: { message: 'Unknown error', code: 2 } }],
  'http-503': () => [503, { ok: false, description: 'Service Unavailable' }],
  'tg-401': () => [401, { ok: false, error_code: 401, description: 'Unauthorized' }],
  'tg-403': () => [403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }],
  'tg-400-chat': () => [400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }],
  'tg-400-parse': () => [400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities" }],
};
const SPECIAL = ['timeout', 'ok-token-expiring'];

function createMock() {
  const queues = { facebook: [], telegram: [] };
  const requests = [];
  const updates = []; // returned (once) by the next getUpdates call
  let sequence = 1000;

  function takeFault(platform) {
    const queue = queues[platform];
    const entry = queue[0];
    if (!entry) return null;
    if (entry.count > 0) {
      entry.count -= 1;
      if (entry.count === 0) queue.shift();
    }
    return entry.fault;
  }

  function reply(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const path = url.pathname;
    const body = await readBody(req);

    if (path === '/__fault') {
      if (req.method === 'DELETE') {
        queues.facebook.length = 0;
        queues.telegram.length = 0;
        return reply(res, 200, { ok: true });
      }
      const spec = JSON.parse(body.toString() || '{}');
      if (!queues[spec.platform] || !(spec.fault in FAULTS || SPECIAL.includes(spec.fault))) {
        return reply(res, 400, { error: 'unknown platform or fault' });
      }
      queues[spec.platform].push({ fault: spec.fault, count: spec.count === undefined ? 1 : Number(spec.count) });
      return reply(res, 200, { ok: true });
    }
    if (path === '/__requests') return reply(res, 200, requests);

    const telegram = path.match(/^\/(?:file\/)?bot[^/]+\/(\w+)/);
    const graph = path.match(/^\/v\d+\.\d+\/(.+)$/);
    const platform = telegram ? 'telegram' : graph ? 'facebook' : null;
    if (!platform) return reply(res, 404, { error: 'not found' });

    const route = telegram ? telegram[1] : graph[1];
    const contentType = req.headers['content-type'] || '';
    requests.push({
      platform, method: req.method, route, bytes: body.length, contentType,
      // JSON bodies only (Send API text), never multipart uploads; tokens travel in headers.
      json: contentType.includes('application/json') ? body.toString() : undefined,
    });

    const fault = takeFault(platform);
    if (fault === 'timeout') return; // never answers; the client's timeout applies
    if (fault && FAULTS[fault]) {
      const [status, payload] = FAULTS[fault](platform);
      return reply(res, status, payload);
    }

    if (platform === 'facebook') {
      if (route === 'me/messages') {
        sequence += 1;
        return reply(res, 200, { recipient_id: 'PSID', message_id: `m_mock_${sequence}` });
      }
      if (route.startsWith('me')) return reply(res, 200, { id: '1234567890', name: 'Mock Page' });
      if (route.startsWith('debug_token')) {
        const soon = Math.floor(Date.now() / 1000) + 3600;
        return reply(res, 200, { data: { type: 'PAGE', is_valid: true, expires_at: fault === 'ok-token-expiring' ? soon : 0 } });
      }
      return reply(res, 404, { error: { message: 'Unknown path', code: 803 } });
    }

    if (route === 'getMe') return reply(res, 200, { ok: true, result: { id: 1, is_bot: true, username: 'mock_bot' } });
    if (route === 'getUpdates') return reply(res, 200, { ok: true, result: updates.splice(0) });
    if (route === 'getFile') return reply(res, 200, { ok: true, result: { file_path: 'docs/a.txt' } });
    sequence += 1;
    return reply(res, 200, { ok: true, result: { message_id: sequence } });
  });

  return {
    server,
    requests,
    listen: (port = 0) => new Promise((resolve) => {
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    }),
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
    inject: (platform, fault, count = 1) => queues[platform].push({ fault, count }),
    queueUpdates: (list) => updates.push(...list),
    clear: () => {
      queues.facebook.length = 0;
      queues.telegram.length = 0;
      requests.length = 0;
    },
  };
}

module.exports = { createMock, FAULTS };

if (require.main === module) {
  const port = Number(process.argv[2] || 4010);
  createMock().listen(port).then((actual) => {
    console.log(`[mock] Graph + Telegram mock listening on http://127.0.0.1:${actual}`);
  });
}
