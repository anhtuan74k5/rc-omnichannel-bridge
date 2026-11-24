/**
 * telegram.js
 * -----------
 * Telegram Bot integration:
 *  - POST /webhook/telegram : receive incoming messages
 *  - pollUpdates()          : receive incoming messages via getUpdates polling
 *  - sendMessage()          : send a message back via Bot API
 */

require('dotenv').config();

const { rememberTelegramName } = require('./customerNames');
const { API, DOCUMENT_EXTENSIONS, ENV, FILES, HEADERS, MIME_TYPES, TELEGRAM_MESSAGE_TYPES } = require('./constants/config');
const { ERRORS } = require('./constants/errors');
const { dumpTelegramUpdate } = require('./debugDump');
const { fetchWithTimeout } = require('./httpClient');
const { log } = require('./logger');
const { buildTelegramMessages, telegramToRcText } = require('./textFormat');
let lastUpdateId = 0;
const processedUpdateIds = new Set();
const updateRetryCounts = new Map();
const MAX_PROCESSED_UPDATE_IDS = 1000;

function rememberProcessedUpdate(updateId) {
  processedUpdateIds.add(updateId);
  while (processedUpdateIds.size > MAX_PROCESSED_UPDATE_IDS) {
    processedUpdateIds.delete(processedUpdateIds.values().next().value);
  }
}

function getExtension(filename) {
  const match = String(filename || '').toLowerCase().match(/\.[^.]+$/);
  return match ? match[0] : '';
}

function getMessageType(message) {
  return TELEGRAM_MESSAGE_TYPES.find((type) => message[type]) || 'unsupported';
}

/**
 * Handle POST webhook payload from Telegram Bot API.
 * Parses chat_id and message text, then calls the provided callback.
 *
 * @param {object} body - parsed JSON body
 * @param {function} onMessage - async (chatId, text) => void
 */
async function handleWebhook(body, onMessage, onDocument, onUnsupportedMessage, onMedia) {
  try {
    dumpTelegramUpdate(body);
  } catch (err) {
    log.warn('[telegram] Failed to dump update payload:', err.message);
  }

  const message = body.message || body.edited_message;
  const edited = !body.message && Boolean(body.edited_message);

  if (!message) {
    log.info('[telegram] Received non-message update, ignoring.');
    return;
  }

  const chatId = message.chat && message.chat.id;
  const text = message.text && telegramToRcText(message.text);
  const caption = message.caption;
  const document = message.document;
  const mediaType = getMessageType(message);

  if (!chatId) {
    log.warn('[telegram] Update without chat id, skipping.');
    return;
  }
  if (ENV.telegramAllowedChatIds.length > 0
    && !ENV.telegramAllowedChatIds.includes(String(chatId))) {
    log.warn('[telegram] Ignoring message from chat outside the allowlist.');
    return;
  }
  rememberTelegramName(chatId, message);

  // Editing a photo/file caption must not re-upload or re-announce the media.
  if (edited && !text) {
    log.info('[telegram] Ignoring edit of a non-text message', { chatId });
    return;
  }

  if (text) {
    log.info('[telegram] Received message', { chatId, type: edited ? 'edited_text' : 'text', length: text.length });
    await onMessage(chatId, text, { edited });
  } else if (document) {
    log.info('[telegram] Received document', { chatId, type: 'document', filenameLength: String(document.file_name || document.file_id || '').length });
    if (onDocument) {
      await onDocument(chatId, document, caption);
    }
  } else if (mediaType !== 'unsupported' && onMedia) {
    log.info('[telegram] Received media', { chatId, type: mediaType });
    await onMedia(chatId, mediaType, message[mediaType], caption);
  } else {
    log.info('[telegram] Received message', { chatId, type: mediaType, length: 0 });
    if (onUnsupportedMessage) {
      await onUnsupportedMessage(chatId, mediaType, caption);
    }
  }
}

async function pollUpdates(onMessage, onDocument, onUnsupportedMessage, onMedia) {
  if (!ENV.telegramBotToken) return;

  const params = new URLSearchParams({
    timeout: '0',
    allowed_updates: JSON.stringify(API.telegram.allowedUpdates),
  });
  if (lastUpdateId > 0) {
    params.set('offset', String(lastUpdateId + 1));
  }

  const url = `${API.telegram.baseUrl}/bot${ENV.telegramBotToken}/getUpdates?${params.toString()}`;
  const res = await fetchWithTimeout(url, {}, { retries: 2 });
  const data = await res.json();

  if (!res.ok || !data.ok) {
    throw new Error(ERRORS.telegram.updateFailed(res.status, data));
  }

  for (const update of data.result || []) {
    const updateId = update.update_id;
    if (processedUpdateIds.has(updateId) || updateId <= lastUpdateId) {
      continue;
    }

    try {
      await handleWebhook(update, onMessage, onDocument, onUnsupportedMessage, onMedia);
      rememberProcessedUpdate(updateId);
      updateRetryCounts.delete(updateId);
      lastUpdateId = updateId;
    } catch (err) {
      const retries = (updateRetryCounts.get(updateId) || 0) + 1;
      updateRetryCounts.set(updateId, retries);
      if (retries < ENV.telegramMaxUpdateRetries) {
        log.warn('[telegram] Update handling failed; retaining offset for retry', {
          updateId,
          attempt: retries,
          error: err.message,
        });
        break;
      }

      log.error('[telegram] Update exceeded retry limit; skipping update', {
        updateId,
        attempts: retries,
        error: err.message,
      });
      rememberProcessedUpdate(updateId);
      updateRetryCounts.delete(updateId);
      lastUpdateId = updateId;
      break;
    }
  }
}

async function downloadDocument(document) {
  if (!ENV.telegramBotToken) {
    throw new Error(ERRORS.telegram.tokenMissing);
  }

  const filename = document.file_name || FILES.defaultDocument;
  const extension = getExtension(filename);
  if (!DOCUMENT_EXTENSIONS.includes(extension)) {
    throw new Error(ERRORS.telegram.unsupportedDocument(extension, DOCUMENT_EXTENSIONS));
  }

  if (document.file_size && document.file_size > ENV.telegramMaxDocumentBytes) {
    throw new Error(ERRORS.telegram.documentTooLarge(ENV.telegramMaxDocumentBytes));
  }

  const fileInfoUrl = `${API.telegram.baseUrl}/bot${ENV.telegramBotToken}/getFile?file_id=${encodeURIComponent(document.file_id)}`;
  const fileInfoRes = await fetchWithTimeout(fileInfoUrl, {}, { retries: 2 });
  const fileInfo = await fileInfoRes.json();
  if (!fileInfoRes.ok || !fileInfo.ok || !fileInfo.result || !fileInfo.result.file_path) {
    throw new Error(ERRORS.telegram.fileInfoFailed(fileInfoRes.status, fileInfo));
  }

  const downloadUrl = `${API.telegram.fileBaseUrl}/bot${ENV.telegramBotToken}/${fileInfo.result.file_path}`;
  const downloadRes = await fetchWithTimeout(downloadUrl, {}, { timeoutMs: ENV.httpUploadTimeoutMs, retries: 2 });
  if (!downloadRes.ok) {
    throw new Error(ERRORS.telegram.fileDownloadFailed(downloadRes.status));
  }

  const buffer = Buffer.from(await downloadRes.arrayBuffer());
  if (buffer.length > ENV.telegramMaxDocumentBytes) {
    throw new Error(ERRORS.telegram.documentTooLarge(ENV.telegramMaxDocumentBytes));
  }

  return {
    filename,
    buffer,
    mimeType: document.mime_type || 'application/octet-stream',
    size: buffer.length,
  };
}

function telegramApiError(status, data) {
  const error = new Error(ERRORS.telegram.sendFailed(status, data));
  error.status = status;
  error.description = String(data && data.description || '');
  return error;
}

/**
 * True when Telegram rejected the *formatting* (not the chat, token or size),
 * so a plain-text resend of the same content is worth trying.
 */
function isEntityParseError(error) {
  return Boolean(error)
    && error.status === 400
    && /can't parse entities|unsupported start tag|unmatched end tag|can't find end tag/i.test(error.description || '');
}

function isMarkdownEnabled(options) {
  return Boolean(options && options.markdown) && ENV.telegramRenderMarkdown;
}

async function postTextMessage(chatId, text, parseMode) {
  const url = `${API.telegram.baseUrl}/bot${ENV.telegramBotToken}/sendMessage`;
  const payload = { chat_id: chatId, text };
  if (parseMode) payload.parse_mode = parseMode;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { [HEADERS.contentType]: 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  }, { retries: 0 });
  const data = await res.json();
  if (!res.ok || !data.ok) throw telegramApiError(res.status, data);
  return data;
}

/**
 * Send one prepared part. If Telegram rejects the formatting, resend the same
 * part as plain text so the customer still receives the agent's message.
 */
async function sendTextPart(chatId, part) {
  log.info('[telegram] Sending message', { chatId, type: 'text', length: part.source.length, formatted: Boolean(part.parseMode) });
  try {
    return await postTextMessage(chatId, part.text, part.parseMode);
  } catch (error) {
    if (!part.parseMode || !isEntityParseError(error)) throw error;
    log.warn('[telegram] Formatting rejected by Telegram; resending as plain text', { chatId, error: error.description });
    return postTextMessage(chatId, part.source);
  }
}

/**
 * Send a text message to a Telegram chat via Bot API.
 * POST https://api.telegram.org/bot<TOKEN>/sendMessage
 *
 * @param {string|number} chatId
 * @param {string} text
 * @param {{markdown?: boolean}} [options] markdown=true renders Rocket.Chat
 *   Markdown (bold/italic/strike/code/links). Leave unset for bridge, system and
 *   AI messages, which must be sent verbatim.
 */
async function sendMessage(chatId, text, options = {}) {
  const parts = buildTelegramMessages(text, { markdown: isMarkdownEnabled(options) });

  let lastData;
  for (const part of parts) {
    lastData = await sendTextPart(chatId, part);
  }

  log.info('[telegram] Message sent', { chatId, type: 'text' });
  return lastData;
}

function mediaError(status, data) {
  return telegramApiError(status, data);
}

async function sendTelegramMedia(method, field, chatId, descriptor, caption, parseMode) {
  if (!descriptor || !Buffer.isBuffer(descriptor.buffer) || descriptor.buffer.length === 0) {
    throw new Error(ERRORS.telegram.mediaInvalidBuffer);
  }
  const url = `${API.telegram.baseUrl}/bot${ENV.telegramBotToken}/${method}`;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  if (caption && parseMode) form.append('parse_mode', parseMode);
  form.append(field, new Blob([descriptor.buffer], {
    type: descriptor.mimeType || MIME_TYPES.octetStream,
  }), descriptor.filename || FILES.defaultUpload);

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    body: form,
  }, { timeoutMs: ENV.httpUploadTimeoutMs, retries: 0 });
  const data = await res.json();
  if (!res.ok || !data.ok) throw mediaError(res.status, data);
  return data;
}

async function sendMediaPart(method, field, chatId, descriptor, caption, options = {}) {
  // Telegram caps captions at 1024 characters; the overflow goes out as text.
  const [first, ...remainders] = buildTelegramMessages(caption, {
    markdown: isMarkdownEnabled(options),
    limit: 1024,
  });

  let result;
  try {
    result = await sendTelegramMedia(method, field, chatId, descriptor, first ? first.text : '', first && first.parseMode);
  } catch (error) {
    if (!first || !first.parseMode || !isEntityParseError(error)) throw error;
    log.warn('[telegram] Caption formatting rejected by Telegram; resending as plain text', { chatId, error: error.description });
    result = await sendTelegramMedia(method, field, chatId, descriptor, first.source);
  }
  for (const remainder of remainders) {
    await sendTextPart(chatId, remainder);
  }
  return result;
}

async function sendPhoto(chatId, descriptor, caption, options) {
  try {
    return await sendMediaPart('sendPhoto', 'photo', chatId, descriptor, caption, options);
  } catch (error) {
    if (error.status !== 400) throw error;
    return sendMediaPart('sendDocument', 'document', chatId, descriptor, caption, options);
  }
}

async function sendDocument(chatId, descriptor, caption, options) {
  return sendMediaPart('sendDocument', 'document', chatId, descriptor, caption, options);
}

async function sendVideo(chatId, descriptor, caption, options) {
  return sendMediaPart('sendVideo', 'video', chatId, descriptor, caption, options);
}

async function sendAudio(chatId, descriptor, caption, options) {
  return sendMediaPart('sendAudio', 'audio', chatId, descriptor, caption, options);
}

async function sendVoice(chatId, descriptor, caption, options) {
  return sendMediaPart('sendVoice', 'voice', chatId, descriptor, caption, options);
}

async function sendAnimation(chatId, descriptor, caption, options) {
  return sendMediaPart('sendAnimation', 'animation', chatId, descriptor, caption, options);
}

async function sendMedia(chatId, descriptor, caption, options) {
  const senders = { image: sendPhoto, animation: sendAnimation, document: sendDocument,
    video: sendVideo, audio: sendAudio, voice: sendVoice };
  const sender = senders[descriptor && descriptor.kind] || sendDocument;
  return sender(chatId, descriptor, caption, options);
}

async function setWebhook(webhookUrl = ENV.telegramWebhookUrl) {
  if (!ENV.telegramBotToken) throw new Error(ERRORS.telegram.tokenMissing);
  if (!webhookUrl) throw new Error('TELEGRAM_WEBHOOK_URL is required');
  const body = {
    url: webhookUrl,
    allowed_updates: API.telegram.allowedUpdates,
  };
  if (ENV.telegramWebhookSecret) body.secret_token = ENV.telegramWebhookSecret;
  const res = await fetchWithTimeout(
    `${API.telegram.baseUrl}/bot${ENV.telegramBotToken}/setWebhook`,
    {
      method: 'POST',
      headers: { [HEADERS.contentType]: 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    },
    { retries: 0 }
  );
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(ERRORS.telegram.sendFailed(res.status, data));
  return data;
}

/** Startup health check via getMe. Never throws and never logs the token. */
async function checkToken() {
  if (!ENV.telegramBotToken) {
    log.info('[telegram] Token check skipped: TELEGRAM_BOT_TOKEN not set.');
    return { ok: false, status: 'missing' };
  }
  try {
    const res = await fetchWithTimeout(`${API.telegram.baseUrl}/bot${ENV.telegramBotToken}/getMe`, {}, { retries: 0, timeoutMs: 8000 });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      log.warn('[telegram] Token check FAILED; the bot token is invalid or revoked.', {
        status: res.status, description: data && data.description,
      });
      return { ok: false, status: res.status === 401 ? 'invalid' : 'error' };
    }
    log.info('[telegram] Token OK', { bot: data.result && data.result.username });
    return { ok: true, status: 'ok', username: data.result && data.result.username };
  } catch (error) {
    log.warn('[telegram] Token check could not reach Telegram.', { error: error.message });
    return { ok: false, status: 'unreachable' };
  }
}

module.exports = {
  checkToken,
  downloadDocument,
  handleWebhook,
  pollUpdates,
  sendAnimation,
  sendAudio,
  sendDocument,
  sendMessage,
  sendMedia,
  sendPhoto,
  sendVideo,
  sendVoice,
  setWebhook,
};

if (require.main === module && process.argv.includes('--set-webhook')) {
  setWebhook()
    .then(() => console.log('[telegram] Webhook configured.'))
    .catch((err) => {
      console.error('[telegram] Failed to configure webhook:', err.message);
      process.exitCode = 1;
    });
}
