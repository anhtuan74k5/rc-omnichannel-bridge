/**
 * rocketchat.js
 * -------------
 * Integration with Rocket.Chat Omnichannel via the /api/v1/livechat/* REST
 * namespace only. No other Rocket.Chat routes are called (they are blocked by
 * the proxy and return 404).
 *
 * IMPORTANT: We use the agent's X-Auth-Token / X-User-Id. They can come from
 * Personal Access Token env vars, or from /api/v1/login with agent credentials.
 * The livechat visitor endpoints accept these headers.
 */

const mapping = require('./mapping');
const { API, ENV, FILES, HEADERS, MIME_TYPES } = require('./constants/config');
const { ERRORS } = require('./constants/errors');
const { dumpRocketChatMessage } = require('./debugDump');
const { fetchWithTimeout } = require('./httpClient');
const { log } = require('./logger');
const { classifyMime } = require('./media/mime');

const ROCKETCHAT_URL = ENV.rocketchatUrl.replace(/\/+$/, '');


// Cached agent session
let agentSession = null; // { authToken, userId, expiresAt }
const visitorMutexes = new Map();
const roomMutexes = new Map();

function withMutex(mutexes, key, task) {
  const previous = mutexes.get(key) || Promise.resolve();
  const current = previous.then(task, task);
  mutexes.set(key, current);
  return current.finally(() => {
    if (mutexes.get(key) === current) mutexes.delete(key);
  });
}

/**
 * Low-level fetch wrapper that adds the agent auth headers and handles
 * re-login + single retry on 401 (token expired) or other auth errors.
 */
async function rcFetch(path, options = {}, retried = false) {
  const { authToken, userId } = await loginAgent();

  const headers = {
    [HEADERS.contentType]: 'application/json',
    [HEADERS.authToken]: authToken,
    [HEADERS.userId]: userId,
    ...(options.headers || {}),
  };

  const url = `${ROCKETCHAT_URL}${path}`;
  const isPollingHistory = path.includes(`${API.rocketChat.messagesHistoryPath}/`);
  if (!isPollingHistory || ENV.debugPolling) {
    log.info(`[rocketchat] ${options.method || 'GET'} ${path}`);
  }

  const res = await fetchWithTimeout(url, { ...options, headers }, {
    retries: options.method && options.method.toUpperCase() === 'GET' ? 2 : 0,
    retryOn: (status) => status >= 500,
  });

  // If token expired / unauthorized, re-login and retry once.
  if (res.status === 401 && !retried) {
    log.warn('[rocketchat] Got 401, re-login and retry once...');
    agentSession = null; // force re-login
    return rcFetch(path, options, true);
  }

  let body = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const err = new Error(ERRORS.rocketchat.api(res.status, text));
    err.status = res.status;
    err.body = body;
    throw err;
  }

  return body;
}

/**
 * loginAgent()
 * ------------
 * Returns a Rocket.Chat auth session. Prefer Personal Access Token env vars
 * when present; otherwise POST /api/v1/login with agent credentials.
 */
async function loginAgent() {
  if (ENV.authToken && ENV.userId) {
    return {
      authToken: ENV.authToken,
      userId: ENV.userId,
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
  }

  if (agentSession && agentSession.expiresAt > Date.now()) {
    return agentSession;
  }

  log.info('[rocketchat] Logging in agent...');
  const res = await fetchWithTimeout(`${ROCKETCHAT_URL}${API.rocketChat.loginPath}`, {
    method: 'POST',
    headers: { [HEADERS.contentType]: 'application/json' },
    body: JSON.stringify({
      user: ENV.agentUsername,
      password: ENV.agentPassword,
    }),
  }, { retries: 0 });

  const body = await res.json();
  if (!res.ok || !body.data || !body.data.authToken) {
    throw new Error(ERRORS.rocketchat.loginFailed(res.status, body));
  }

  agentSession = {
    authToken: body.data.authToken,
    userId: body.data.userId,
    // Rocket.Chat tokens typically last 10 days; we refresh a bit earlier.
    expiresAt: Date.now() + 9 * 24 * 60 * 60 * 1000,
  };
  log.info('[rocketchat] Agent logged in successfully.');
  return agentSession;
}

/**
 * getOrCreateVisitor(platformUserId, name, department)
 * ----------------------------------------------------
 * Maps a platform user id (PSID or chat_id) to a fixed visitor token.
 * The token is generated deterministically from the platform user id so it
 * stays stable across restarts. If the visitor was never created on
 * Rocket.Chat, POST /api/v1/livechat/visitor is called.
 */
async function getOrCreateVisitor(platformUserId, name, department) {
  const key = String(platformUserId);
  return withMutex(visitorMutexes, key, async () => {
    // Deterministic token derived from the platform user id.
    const visitorToken = `visitor_${platformUserId}`;

    // Check if we already created this visitor on Rocket.Chat.
    const existing = mapping.findByVisitorToken(visitorToken);
    if (existing && existing.visitorToken) {
      log.info('[rocketchat] Visitor already exists', { visitorToken });
      return visitorToken;
    }

    log.info('[rocketchat] Creating visitor', { platformUserId, nameLength: String(name || '').length });
    const body = await rcFetch(API.rocketChat.visitorPath, {
      method: 'POST',
      body: JSON.stringify({
        visitor: {
          token: visitorToken,
          name: name || `Visitor ${platformUserId}`,
          email: `${platformUserId}@bridge.local`,
          department: department || ENV.departmentId || undefined,
        },
      }),
    });

    if (!body || !body.success) {
      throw new Error(ERRORS.rocketchat.visitorFailed(body));
    }

    log.info('[rocketchat] Visitor created', { visitorToken });
    return visitorToken;
  });
}

/**
 * getOrCreateRoom(visitorToken)
 * -----------------------------
 * GET /api/v1/livechat/room?token=... to fetch (or implicitly create) the
 * room for a visitor. Returns the room id.
 */
async function getOrCreateRoom(visitorToken) {
  return withMutex(roomMutexes, String(visitorToken), async () => {
    const existing = mapping.findByVisitorToken(visitorToken);
    if (existing && existing.roomId) {
      log.info('[rocketchat] Room already known', { visitorToken, roomId: existing.roomId });
      return existing.roomId;
    }

    log.info('[rocketchat] Fetching room', { visitorToken });
    const body = await rcFetch(`${API.rocketChat.roomPath}?token=${encodeURIComponent(visitorToken)}`);

    if (!body || !body.room || !body.room._id) {
      throw new Error(ERRORS.rocketchat.roomFailed(body));
    }

    const roomId = body.room._id;
    log.info('[rocketchat] Room resolved', { roomId });

    if (existing) {
      mapping.update(existing, { roomId });
    }
    return roomId;
  });
}

/**
 * sendMessageToRocketChat(visitorToken, roomId, text)
 * ---------------------------------------------------
 * POST /api/v1/livechat/message to send a visitor message into the room.
 */
async function sendMessageToRocketChat(visitorToken, roomId, text) {
  log.info('[rocketchat] Sending visitor message', { roomId, type: 'text', length: text.length });
  const body = await rcFetch(API.rocketChat.messagePath, {
    method: 'POST',
    body: JSON.stringify({
      token: visitorToken,
      rid: roomId,
      msg: text,
    }),
  });

  if (!body || !body.success) {
    throw new Error(ERRORS.rocketchat.messageFailed(body));
  }

  log.info('[rocketchat] Visitor message sent successfully.');
  return body;
}

async function uploadLivechatFile(visitorToken, roomId, { filename, buffer, mimeType, description }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error(ERRORS.rocketchat.uploadInvalidBuffer);
  }

  const form = new FormData();
  const file = new Blob([buffer], { type: mimeType || MIME_TYPES.octetStream });
  form.append('file', file, filename || FILES.defaultUpload);
  if (description) {
    form.append('description', description);
  }

  const url = `${ROCKETCHAT_URL}${API.rocketChat.uploadPath}/${encodeURIComponent(roomId)}`;
  log.info('[rocketchat] Uploading visitor file', { roomId, filenameLength: String(filename || '').length });
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      [HEADERS.visitorToken]: visitorToken,
    },
    body: form,
  }, { timeoutMs: ENV.httpUploadTimeoutMs, retries: 0 });

  let body = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok || !body || body.success === false) {
    throw new Error(ERRORS.rocketchat.uploadFailed(res.status, text));
  }

  log.info('[rocketchat] Visitor file uploaded successfully.');
  return body;
}

/**
 * Extract unique attachment descriptors from a captured messages.history item.
 * The descriptor does not contain a downloaded buffer.
 *
 * @param {object} message
 * @returns {Array<import('./media/types').MediaDescriptor>}
 */
function extractAttachments(message) {
  const fileUpload = message && message.fileUpload;
  const candidates = [];
  const file = message && message.file;
  const files = Array.isArray(message && message.files) ? message.files : [];
  const attachments = Array.isArray(message && message.attachments) ? message.attachments : [];

  for (const item of attachments) candidates.push({
    id: item && item.fileId,
    filename: item && item.title,
    mimeType: item && item.mimeType,
    size: item && item.size,
    source: item && item.title_link,
  });
  if (file) candidates.push({
    id: file._id,
    filename: file.name,
    mimeType: file.type,
    size: file.size,
    source: fileUpload && fileUpload.publicFilePath,
  });
  for (const item of files) candidates.push({
    id: item && item._id,
    filename: item && item.name,
    mimeType: item && item.type,
    size: item && item.size,
    source: fileUpload && fileUpload.publicFilePath,
  });

  const seen = new Set();
  const normalizeSource = (source) => {
    try {
      const parsed = new URL(source, ROCKETCHAT_URL || 'http://localhost');
      return parsed.pathname;
    } catch {
      return String(source || '');
    }
  };
  return candidates
    .map((candidate) => {
      const source = String(candidate.source || '');
      const filename = candidate.filename || source.split(/[\\/]/).pop() || 'download';
      const mimeType = candidate.mimeType || '';
      const identities = [
        candidate.id && `id:${candidate.id}`,
        source && `source:${normalizeSource(source)}`,
        `file:${filename}:${mimeType}:${candidate.size || ''}`,
      ].filter(Boolean);
      return {
        identities,
        descriptor: {
          kind: classifyMime(mimeType, filename),
          filename,
          mimeType,
          size: Number(candidate.size || 0),
          source,
        },
      };
    })
    .filter(({ identities, descriptor }) => {
      if (!descriptor.source || identities.some((identity) => seen.has(identity))) return false;
      identities.forEach((identity) => seen.add(identity));
      return true;
    })
    .map(({ descriptor }) => descriptor);
}

/**
 * pollNewAgentMessages(roomId, visitorToken, lastMessageTimestamp)
 * ----------------------------------------------------------------
 * GET /api/v1/livechat/messages.history/{roomId}?token=...
 * Filters messages newer than lastMessageTimestamp AND whose sender is NOT
 * the visitor (i.e. messages from the agent). Returns the list of new
 * messages (oldest first).
 */
async function pollNewAgentMessages(roomId, visitorToken, lastMessageTimestamp, processedMessageIds = []) {
  const url = `${API.rocketChat.messagesHistoryPath}/${encodeURIComponent(roomId)}?token=${encodeURIComponent(visitorToken)}`;
  const body = await rcFetch(url);

  const messages = (body && body.messages) || [];
  const newMessages = messages
    .filter((m) => {
      const ts = new Date(m.ts).getTime();
      // Timestamp is a coarse filter; message ids disambiguate equal timestamps.
      if (ts < lastMessageTimestamp) return false;
      if (m._id && processedMessageIds.includes(m._id)) return false;
      // Only messages NOT sent by the visitor (i.e. from the agent).
      if (m.token === visitorToken) return false;
      if (m.t) return false;
      try {
        dumpRocketChatMessage(m);
      } catch (err) {
        log.warn('[rocketchat] Failed to dump message payload:', err.message);
      }
      return true;
    })
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));

  if (newMessages.length > 0) {
    log.info('[rocketchat] Poll found new agent messages', { count: newMessages.length, roomId });
  }

  return newMessages;
}

module.exports = {
  loginAgent,
  getOrCreateVisitor,
  getOrCreateRoom,
  extractAttachments,
  uploadLivechatFile,
  sendMessageToRocketChat,
  pollNewAgentMessages,
};
