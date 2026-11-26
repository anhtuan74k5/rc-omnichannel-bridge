/**
 * zalo.js
 * -------
 * Zalo Official Account adapter.
 *
 * STATUS: built and tested against the local mock only (scripts/e2e/mock-platforms.js).
 * The endpoints, the webhook signature and the error codes follow Zalo's public
 * OA documentation, but nothing here has been verified with a real Official
 * Account. Off unless ZALO_ENABLED=true. Refreshing the access token is not
 * implemented.
 */

const crypto = require('crypto');

const { ENV, MIME_TYPES } = require('../constants/config');
const { ERRORS } = require('../constants/errors');
const { fetchWithTimeout } = require('../lib/httpClient');
const { log } = require('../lib/logger');
const { rcMarkdownToPlainText, splitByUtf16 } = require('../core/textFormat');

const ZALO_TEXT_LIMIT = 2000;

// event_name -> the attachment type the bridge uses
const MEDIA_EVENTS = Object.freeze({
  user_send_image: 'image',
  user_send_gif: 'image',
  user_send_sticker: 'image',
  user_send_audio: 'audio',
  user_send_video: 'video',
  user_send_file: 'file',
  user_send_location: 'location',
  user_send_link: 'link',
});

/**
 * X-ZEvent-Signature: "mac=" + sha256(appId + rawBody + timestamp + OA secret).
 * False when anything needed to check it is missing.
 */
function verifySignature(rawBody, signatureHeader, timestamp, { appId = ENV.zaloAppId, secret = ENV.zaloOaSecretKey } = {}) {
  if (!appId || !secret || !Buffer.isBuffer(rawBody) || !timestamp) return false;
  const received = Buffer.from(String(signatureHeader || '').replace(/^mac=/, ''), 'hex');
  const expected = crypto.createHash('sha256')
    .update(String(appId)).update(rawBody).update(String(timestamp)).update(String(secret))
    .digest();
  return received.length === expected.length && crypto.timingSafeEqual(expected, received);
}

/**
 * @param {object} body - one webhook event
 * @param {function} onText - async (userId, text, {key}) => void
 * @param {function} onAttachment - async (userId, {type, payload}, {key}) => void
 */
async function handleWebhook(body, onText, onAttachment) {
  const event = String((body && body.event_name) || '');
  // Only what customers send; "oa_send_*", read receipts and follows are ignored.
  if (!event.startsWith('user_send_')) {
    log.debug('[zalo] Ignored event', { event: event || 'none' });
    return;
  }
  const userId = body.sender && body.sender.id;
  const message = body.message || {};
  if (!userId) {
    log.warn('[zalo] Event without sender id, skipping.');
    return;
  }
  const keyFor = (part) => (message.msg_id ? `${message.msg_id}:${part}` : null);
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];

  if (message.text) {
    log.info('[zalo] Received message', { userId, type: 'text', length: message.text.length });
    await onText(userId, message.text, { key: keyFor('text') });
  }
  const type = MEDIA_EVENTS[event];
  if (!type) {
    if (!message.text) await onAttachment(userId, { type: event.replace('user_send_', ''), payload: {} }, { key: keyFor(0) });
    return;
  }
  let index = 0;
  for (const attachment of attachments) {
    log.info('[zalo] Received attachment', { userId, type });
    await onAttachment(userId, { type, payload: (attachment && attachment.payload) || {} }, { key: keyFor(index) });
    index += 1;
  }
}

function zaloApiError(status, data) {
  const error = new Error(ERRORS.zalo.sendFailed(status, data));
  error.status = status;
  error.code = data && Number(data.error);
  return error;
}

/** Zalo answers HTTP 200 with `error` != 0 for most failures. */
async function callApi(path, options, policy = {}) {
  if (!ENV.zaloAccessToken) throw new Error(ERRORS.zalo.tokenMissing);
  const res = await fetchWithTimeout(`${ENV.zaloApiBaseUrl}${path}`, {
    ...options,
    headers: { access_token: ENV.zaloAccessToken, ...(options.headers || {}) },
  }, { retries: 0, ...policy });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error !== 0) throw zaloApiError(res.status, data);
  return data;
}

function postMessage(userId, message) {
  return callApi('/v3.0/oa/message/cs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { user_id: String(userId) }, message }),
  });
}

/** Send text verbatim, split into parts of at most 2000 characters, in order. */
async function sendMessage(userId, text) {
  let last = null;
  for (const part of splitByUtf16(String(text || ''), ZALO_TEXT_LIMIT)) {
    log.info('[zalo] Sending message', { userId, type: 'text', length: part.length });
    last = await postMessage(userId, { text: part });
  }
  log.info('[zalo] Message sent', { userId, type: 'text' });
  return last;
}

/** Agent text: Zalo shows plain text, so Markdown markers are removed. */
async function sendAgentMessage(userId, text, { timeZone } = {}) {
  const plain = rcMarkdownToPlainText(text, { timeOptions: { timeZone } });
  return plain.trim() ? sendMessage(userId, plain) : null;
}

/** The file types the OA upload endpoints accept; anything else cannot be sent. */
function uploadKind(descriptor) {
  const name = String(descriptor.filename || '').toLowerCase();
  if (/\.(jpe?g|png)$/.test(name)) return 'image';
  if (/\.gif$/.test(name)) return 'gif';
  if (/\.(pdf|docx?)$/.test(name)) return 'file';
  return null;
}

async function sendMedia(userId, descriptor) {
  if (!descriptor || !Buffer.isBuffer(descriptor.buffer) || descriptor.buffer.length === 0) {
    throw new Error(ERRORS.zalo.mediaInvalidBuffer);
  }
  const kind = uploadKind(descriptor);
  if (!kind) {
    const error = new Error(ERRORS.zalo.mediaUnsupported);
    error.status = 400;
    throw error;
  }
  const form = new FormData();
  form.append('file', new Blob([descriptor.buffer], {
    type: descriptor.mimeType || MIME_TYPES.octetStream,
  }), descriptor.filename);

  log.info('[zalo] Sending media', { userId, type: kind, size: descriptor.buffer.length });
  const upload = await callApi(`/v2.0/oa/upload/${kind}`, { method: 'POST', body: form }, { timeoutMs: ENV.httpUploadTimeoutMs });
  const uploaded = upload.data || {};
  const attachment = kind === 'file'
    ? { type: 'file', payload: { token: uploaded.token } }
    : { type: 'template', payload: { template_type: 'media', elements: [{ media_type: kind, attachment_id: uploaded.attachment_id }] } };
  const result = await postMessage(userId, { attachment });
  log.info('[zalo] Media sent', { userId, type: kind });
  return result;
}

module.exports = { handleWebhook, sendAgentMessage, sendMedia, sendMessage, verifySignature };
