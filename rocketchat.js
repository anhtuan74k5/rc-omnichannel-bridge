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

const ROCKETCHAT_URL = ENV.rocketchatUrl.replace(/\/+$/, '');


// Cached agent session
let agentSession = null; // { authToken, userId, expiresAt }

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
    console.log(`[rocketchat] ${options.method || 'GET'} ${path}`);
  }

  const res = await fetch(url, { ...options, headers });

  // If token expired / unauthorized, re-login and retry once.
  if (res.status === 401 && !retried) {
    console.warn('[rocketchat] Got 401, re-login and retry once...');
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

  console.log('[rocketchat] Logging in agent...');
  const res = await fetch(`${ROCKETCHAT_URL}${API.rocketChat.loginPath}`, {
    method: 'POST',
    headers: { [HEADERS.contentType]: 'application/json' },
    body: JSON.stringify({
      user: ENV.agentUsername,
      password: ENV.agentPassword,
    }),
  });

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
  console.log('[rocketchat] Agent logged in successfully.');
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
  // Deterministic token derived from the platform user id.
  const visitorToken = `visitor_${platformUserId}`;

  // Check if we already created this visitor on Rocket.Chat.
  const existing = mapping.findByVisitorToken(visitorToken);
  if (existing && existing.visitorToken) {
    console.log(`[rocketchat] Visitor already exists for token ${visitorToken}`);
    return visitorToken;
  }

  console.log(`[rocketchat] Creating visitor for ${platformUserId} (${name})...`);
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

  console.log(`[rocketchat] Visitor created with token ${visitorToken}`);
  return visitorToken;
}

/**
 * getOrCreateRoom(visitorToken)
 * -----------------------------
 * GET /api/v1/livechat/room?token=... to fetch (or implicitly create) the
 * room for a visitor. Returns the room id.
 */
async function getOrCreateRoom(visitorToken) {
  const existing = mapping.findByVisitorToken(visitorToken);
  if (existing && existing.roomId) {
    console.log(`[rocketchat] Room already known for token ${visitorToken}: ${existing.roomId}`);
    return existing.roomId;
  }

  console.log(`[rocketchat] Fetching room for token ${visitorToken}...`);
  const body = await rcFetch(`${API.rocketChat.roomPath}?token=${encodeURIComponent(visitorToken)}`);

  if (!body || !body.room || !body.room._id) {
    throw new Error(ERRORS.rocketchat.roomFailed(body));
  }

  const roomId = body.room._id;
  console.log(`[rocketchat] Room resolved: ${roomId}`);

  if (existing) {
    mapping.update(existing, { roomId });
  }
  return roomId;
}

/**
 * sendMessageToRocketChat(visitorToken, roomId, text)
 * ---------------------------------------------------
 * POST /api/v1/livechat/message to send a visitor message into the room.
 */
async function sendMessageToRocketChat(visitorToken, roomId, text) {
  console.log(`[rocketchat] Sending visitor message to room ${roomId}: "${text}"`);
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

  console.log('[rocketchat] Visitor message sent successfully.');
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
  console.log(`[rocketchat] Uploading visitor file to room ${roomId}: "${filename}"`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      [HEADERS.visitorToken]: visitorToken,
    },
    body: form,
  });

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

  console.log('[rocketchat] Visitor file uploaded successfully.');
  return body;
}

/**
 * pollNewAgentMessages(roomId, visitorToken, lastMessageTimestamp)
 * ----------------------------------------------------------------
 * GET /api/v1/livechat/messages.history/{roomId}?token=...
 * Filters messages newer than lastMessageTimestamp AND whose sender is NOT
 * the visitor (i.e. messages from the agent). Returns the list of new
 * messages (oldest first).
 */
async function pollNewAgentMessages(roomId, visitorToken, lastMessageTimestamp) {
  const url = `${API.rocketChat.messagesHistoryPath}/${encodeURIComponent(roomId)}?token=${encodeURIComponent(visitorToken)}`;
  const body = await rcFetch(url);

  const messages = (body && body.messages) || [];
  const newMessages = messages
    .filter((m) => {
      const ts = new Date(m.ts).getTime();
      // Only messages newer than the last seen timestamp.
      if (ts <= lastMessageTimestamp) return false;
      // Only messages NOT sent by the visitor (i.e. from the agent).
      if (m.token === visitorToken) return false;
      return true;
    })
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));

  if (newMessages.length > 0) {
    console.log(`[rocketchat] Poll found ${newMessages.length} new agent message(s) in room ${roomId}`);
  }

  return newMessages;
}

module.exports = {
  loginAgent,
  getOrCreateVisitor,
  getOrCreateRoom,
  uploadLivechatFile,
  sendMessageToRocketChat,
  pollNewAgentMessages,
};
