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

const { API, ENV, FILES, HEADERS, MIME_TYPES } = require('./constants/config');
const { ERRORS } = require('./constants/errors');
const { fetchWithTimeout } = require('./httpClient');
const { log } = require('./logger');
const { rcMarkdownToPlainText, splitByUtf16 } = require('./textFormat');

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

const MESSAGES_URL = () => `https://graph.facebook.com/${API.facebook.graphVersion}/me/messages`;
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
async function sendTextPart(psid, text) {
  const body = {
    messaging_type: 'RESPONSE',
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

  const type = toAttachmentType(descriptor.kind);
  const form = new FormData();
  form.append('recipient', JSON.stringify({ id: psid }));
  form.append('messaging_type', 'RESPONSE');
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

module.exports = {
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
