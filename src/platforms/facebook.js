/**
 * facebook.js
 * -----------
 * Facebook Messenger integration:
 *  - GET  /webhook/facebook : webhook verification (hub.verify_token)
 *  - POST /webhook/facebook : receive incoming messages (text + attachments)
 *  - verifySignature()      : validate X-Hub-Signature-256 against FB_APP_SECRET
 *  - sendMessage()          : send text back via Graph API
 *  - sendMedia()            : upload and send an attachment via Graph API
 */

const crypto = require('crypto');

const { API, ENV, FILES, HEADERS, MIME_TYPES } = require('../constants/config');
const { ERRORS } = require('../constants/errors');
const { fetchWithTimeout } = require('../lib/httpClient');
const { log } = require('../lib/logger');
const { rcMarkdownToPlainText, splitByUtf16 } = require('../core/textFormat');

// Messenger rejects text longer than 2000 characters.
const MESSENGER_TEXT_LIMIT = 2000;

function facebookApiError(status, data) {
  const error = new Error(ERRORS.facebook.sendFailed(status, data));
  error.status = status;
  error.code = data && data.error && data.error.code;
  error.subcode = data && data.error && data.error.error_subcode;
  return error;
}

/**
 * Meta delivers one sticker twice, as `image` and as `sticker` (same URL and
 * sticker_id). Keep a single attachment; a lone sticker is handled as an image.
 */
function normalizeAttachments(attachments) {
  const list = (Array.isArray(attachments) ? attachments : []).filter(Boolean);
  const urlOf = (item) => item.payload && item.payload.url;
  const stickerIdOf = (item) => item.payload && item.payload.sticker_id;
  return list
    .filter((item, index) => item.type !== 'sticker' || !list.some((other, otherIndex) => (
      otherIndex !== index
      && other.type !== 'sticker'
      && ((urlOf(item) && urlOf(item) === urlOf(other))
        || (stickerIdOf(item) && stickerIdOf(item) === stickerIdOf(other)))
    )))
    .map((item) => (item.type === 'sticker' ? { ...item, type: 'image' } : item));
}

const GRAPH_URL = () => `${API.facebook.graphBaseUrl}/${API.facebook.graphVersion}`;
const MESSAGES_URL = () => `${GRAPH_URL()}/me/messages`;
const MEDIA_ATTACHMENT_TYPES = new Set(['image', 'video', 'audio', 'file']);

/**
 * Check Meta's X-Hub-Signature-256 header ("sha256=<hex>") against the raw
 * request body. Returns false when the header or secret is missing or wrong.
 */
function verifySignature(rawBody, signatureHeader, appSecret = ENV.facebookAppSecret) {
  if (!appSecret || !Buffer.isBuffer(rawBody)) return false;
  const header = String(signatureHeader || '');
  if (!header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(expected, received);
}

/**
 * Handle GET webhook verification from Facebook.
 * Returns the hub.challenge if hub.verify_token matches FB_VERIFY_TOKEN.
 */
function handleVerify(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  log.info('[facebook] Webhook verify request', { mode });

  if (mode === 'subscribe' && ENV.facebookVerifyToken && token === ENV.facebookVerifyToken) {
    log.info('[facebook] Webhook verified successfully.');
    res.status(200).send(challenge);
  } else {
    log.warn('[facebook] Webhook verification failed (token mismatch).');
    res.sendStatus(403);
  }
}

/**
 * Handle POST webhook payload from Facebook Messenger.
 *
 * @param {object} body - parsed JSON body
 * @param {function} onMessage - async (psid, text, {mid, key}) => void
 * @param {function} [onAttachment] - async (psid, attachment, {mid, key}) => void,
 *   once per attachment ({type, payload: {url, ...}, title?})
 */
async function handleWebhook(body, onMessage, onAttachment) {
  if (!body || body.object !== 'page') {
    log.warn('[facebook] Ignoring non-page webhook event.');
    return;
  }

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const psid = event.sender && event.sender.id;
      const message = event.message;

      if (!psid) {
        log.warn('[facebook] Event without sender id, skipping.');
        continue;
      }
      if (!message || message.is_echo) {
        log.info('[facebook] Received non-message event', { psid, type: 'ignored', length: 0 });
        continue;
      }

      // `key` identifies one deliverable part of a message so a redelivered
      // webhook can be recognised; it is null when Meta sent no message id.
      const mid = message.mid;
      const keyFor = (part) => (mid ? `${mid}:${part}` : null);

      if (message.text) {
        log.info('[facebook] Received message', { psid, type: 'text', length: message.text.length });
        await onMessage(psid, message.text, { mid, key: keyFor('text') });
      }

      let index = 0;
      for (const attachment of normalizeAttachments(message.attachments)) {
        log.info('[facebook] Received attachment', { psid, type: attachment && attachment.type });
        if (onAttachment) await onAttachment(psid, attachment, { mid, key: keyFor(index) });
        index += 1;
      }
    }
  }
}

function assertToken() {
  if (!ENV.facebookPageAccessToken) throw new Error(ERRORS.facebook.tokenMissing);
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${ENV.facebookPageAccessToken}`, ...extra };
}

/**
 * Send a text message to a Facebook user via Graph API.
 * POST https://graph.facebook.com/<version>/me/messages
 */
/** Outside the 24 h standard messaging window (Graph code 10 / subcode 2018278). */
function isOutsideMessagingWindow(error) {
  return Boolean(error) && (error.code === 10 || error.subcode === 2018278);
}

/**
 * Opt-in (FB_HUMAN_AGENT_TAG=true): when Meta refuses a reply because the 24 h
 * window passed, send it again with the HUMAN_AGENT tag, which allows replies
 * from a human agent for 7 days. Without the tag permission Meta refuses again
 * and the usual failure notice reaches the agent.
 */
async function withHumanAgentFallback(send, psid) {
  try {
    return await send(false);
  } catch (error) {
    if (!ENV.facebookHumanAgentTag || !isOutsideMessagingWindow(error)) throw error;
    log.info('[facebook] 24 h window passed; retrying with the HUMAN_AGENT tag', { psid });
    return send(true);
  }
}

function sendTextPart(psid, text) {
  return withHumanAgentFallback((tagged) => postTextPart(psid, text, tagged), psid);
}

async function postTextPart(psid, text, tagged) {
  const body = {
    messaging_type: tagged ? 'MESSAGE_TAG' : 'RESPONSE',
    ...(tagged ? { tag: 'HUMAN_AGENT' } : {}),
    recipient: { id: psid },
    message: { text },
  };

  log.info('[facebook] Sending message', { psid, type: 'text', length: text.length });
  const res = await fetchWithTimeout(MESSAGES_URL(), {
    method: 'POST',
    headers: authHeaders({ [HEADERS.contentType]: 'application/json' }),
    body: JSON.stringify(body),
  }, { retries: 0 });

  const data = await res.json();
  if (!res.ok || data.error) throw facebookApiError(res.status, data);
  return data;
}

/** Send text verbatim, split into parts of at most 2000 characters, in order. */
async function sendMessage(psid, text) {
  assertToken();
  let last = null;
  for (const part of splitByUtf16(String(text || ''), MESSENGER_TEXT_LIMIT)) {
    last = await sendTextPart(psid, part);
  }
  log.info('[facebook] Message sent', { psid, type: 'text' });
  return last;
}

/**
 * Send an agent's Rocket.Chat message: Markdown markers are removed (Messenger
 * has no formatting), timestamps become readable dates, long text is split.
 */
async function sendAgentMessage(psid, text, { timeZone } = {}) {
  const plain = rcMarkdownToPlainText(text, { timeOptions: { timeZone } });
  if (!plain.trim()) return null;
  return sendMessage(psid, plain);
}

/** Map the bridge's media kind to a Messenger attachment type. */
function toAttachmentType(kind) {
  if (kind === 'image' || kind === 'animation') return 'image';
  if (kind === 'video') return 'video';
  if (kind === 'audio' || kind === 'voice') return 'audio';
  return 'file';
}

/**
 * Upload a binary attachment and send it in one request.
 * Messenger has no captions, so callers send the caption as a separate text.
 */
async function sendMedia(psid, descriptor) {
  assertToken();
  if (!descriptor || !Buffer.isBuffer(descriptor.buffer) || descriptor.buffer.length === 0) {
    throw new Error(ERRORS.facebook.mediaInvalidBuffer);
  }
  return withHumanAgentFallback((tagged) => postMedia(psid, descriptor, tagged), psid);
}

async function postMedia(psid, descriptor, tagged) {
  const type = toAttachmentType(descriptor.kind);
  const form = new FormData();
  form.append('recipient', JSON.stringify({ id: psid }));
  form.append('messaging_type', tagged ? 'MESSAGE_TAG' : 'RESPONSE');
  if (tagged) form.append('tag', 'HUMAN_AGENT');
  form.append('message', JSON.stringify({ attachment: { type, payload: { is_reusable: false } } }));
  form.append('filedata', new Blob([descriptor.buffer], {
    type: descriptor.mimeType || MIME_TYPES.octetStream,
  }), descriptor.filename || FILES.defaultUpload);

  log.info('[facebook] Sending media', { psid, type, size: descriptor.buffer.length });
  const res = await fetchWithTimeout(MESSAGES_URL(), {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  }, { timeoutMs: ENV.httpUploadTimeoutMs, retries: 0 });

  const data = await res.json();
  if (!res.ok || data.error) throw facebookApiError(res.status, data);

  log.info('[facebook] Media sent', { psid, type });
  return data;
}

const TOKEN_EXPIRY_WARN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Startup health check of the Page token via /me and debug_token. Never throws
 * and never logs the token; returns {ok, status, ...} so callers can ignore it.
 */
async function checkToken() {
  if (!ENV.facebookPageAccessToken) {
    log.info('[facebook] Token check skipped: FB_PAGE_ACCESS_TOKEN not set.');
    return { ok: false, status: 'missing' };
  }
  try {
    const meRes = await fetchWithTimeout(`${GRAPH_URL()}/me?fields=id,name`, { headers: authHeaders() }, { retries: 0, timeoutMs: 8000 });
    const me = await meRes.json();
    if (!meRes.ok || me.error) {
      const code = me.error && me.error.code;
      log.warn('[facebook] Token check FAILED; sending will not work until fixed.', {
        status: meRes.status, code, message: me.error && me.error.message,
      });
      return { ok: false, status: code === 190 ? 'invalid' : 'error', code };
    }
    let expiresAt = 0;
    try {
      const dbgRes = await fetchWithTimeout(
        `${GRAPH_URL()}/debug_token?input_token=${encodeURIComponent(ENV.facebookPageAccessToken)}`,
        { headers: authHeaders() }, { retries: 0, timeoutMs: 8000 }
      );
      const dbg = (await dbgRes.json()).data || {};
      expiresAt = Number(dbg.expires_at) || 0;
    } catch (error) {
      log.warn('[facebook] debug_token unavailable; expiry unknown.', { error: error.message });
    }
    if (expiresAt > 0) {
      const remaining = expiresAt * 1000 - Date.now();
      if (remaining < TOKEN_EXPIRY_WARN_MS) {
        log.warn('[facebook] Token expires soon; create a new token.', { expiresAt: new Date(expiresAt * 1000).toISOString() });
        return { ok: true, status: 'expiring', pageId: me.id, expiresAt };
      }
    }
    log.info('[facebook] Token OK', { page: me.name, pageId: me.id, expires: expiresAt ? new Date(expiresAt * 1000).toISOString() : 'never' });
    return { ok: true, status: 'ok', pageId: me.id, expiresAt };
  } catch (error) {
    log.warn('[facebook] Token check could not reach Graph API.', { error: error.message });
    return { ok: false, status: 'unreachable' };
  }
}

module.exports = {
  checkToken,
  MEDIA_ATTACHMENT_TYPES,
  handleVerify,
  handleWebhook,
  normalizeAttachments,
  sendAgentMessage,
  sendMedia,
  sendMessage,
  toAttachmentType,
  verifySignature,
};
