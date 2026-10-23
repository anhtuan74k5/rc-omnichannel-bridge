/**
 * telegram.js
 * -----------
 * Telegram Bot integration:
 *  - POST /webhook/telegram : receive incoming messages
 *  - pollUpdates()          : receive incoming messages via getUpdates polling
 *  - sendMessage()          : send a message back via Bot API
 */

const { API, DOCUMENT_EXTENSIONS, ENV, FILES, HEADERS, MIME_TYPES, TELEGRAM_MESSAGE_TYPES } = require('./constants/config');
const { ERRORS } = require('./constants/errors');
const { dumpTelegramUpdate } = require('./debugDump');
const { fetchWithTimeout } = require('./httpClient');
const { log } = require('./logger');
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
async function handleWebhook(body, onMessage, onDocument, onUnsupportedMessage) {
  try {
    dumpTelegramUpdate(body);
  } catch (err) {
    log.warn('[telegram] Failed to dump update payload:', err.message);
  }

  const message = body.message || body.edited_message;

  if (!message) {
    log.info('[telegram] Received non-message update, ignoring.');
    return;
  }

  const chatId = message.chat && message.chat.id;
  const text = message.text;
  const caption = message.caption;
  const document = message.document;

  if (!chatId) {
    log.warn('[telegram] Update without chat id, skipping.');
    return;
  }

  if (text) {
    log.info('[telegram] Received message', { chatId, type: 'text', length: text.length });
    await onMessage(chatId, text);
  } else if (document) {
    log.info('[telegram] Received document', { chatId, type: 'document', filenameLength: String(document.file_name || document.file_id || '').length });
    if (onDocument) {
      await onDocument(chatId, document, caption);
    }
  } else {
    const messageType = getMessageType(message);
    log.info('[telegram] Received message', { chatId, type: messageType, length: 0 });
    if (onUnsupportedMessage) {
      await onUnsupportedMessage(chatId, messageType, caption);
    }
  }
}

async function pollUpdates(onMessage, onDocument, onUnsupportedMessage) {
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
      await handleWebhook(update, onMessage, onDocument, onUnsupportedMessage);
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

/**
 * Send a text message to a Telegram chat via Bot API.
 * POST https://api.telegram.org/bot<TOKEN>/sendMessage
 */
async function sendMessage(chatId, text) {
  const url = `${API.telegram.baseUrl}/bot${ENV.telegramBotToken}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
  };

  log.info('[telegram] Sending message', { chatId, type: 'text', length: text.length });
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { [HEADERS.contentType]: 'application/json' },
    body: JSON.stringify(body),
  }, { retries: 0 });

  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(ERRORS.telegram.sendFailed(res.status, data));
  }

  log.info('[telegram] Message sent', { chatId, type: 'text' });
  return data;
}

function mediaError(status, data) {
  const error = new Error(ERRORS.telegram.sendFailed(status, data));
  error.status = status;
  return error;
}

async function sendTelegramMedia(method, field, chatId, descriptor, caption) {
  if (!descriptor || !Buffer.isBuffer(descriptor.buffer) || descriptor.buffer.length === 0) {
    throw new Error(ERRORS.telegram.mediaInvalidBuffer);
  }
  const url = `${API.telegram.baseUrl}/bot${ENV.telegramBotToken}/${method}`;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  const captionText = String(caption || '');
  if (captionText) form.append('caption', captionText.slice(0, 1024));
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

async function sendMediaPart(method, field, chatId, descriptor, caption) {
  const result = await sendTelegramMedia(method, field, chatId, descriptor, caption);
  const remainder = String(caption || '').slice(1024);
  if (remainder) await sendMessage(chatId, remainder);
  return result;
}

async function sendPhoto(chatId, descriptor, caption) {
  try {
    return await sendMediaPart('sendPhoto', 'photo', chatId, descriptor, caption);
  } catch (error) {
    if (error.status !== 400) throw error;
    return sendMediaPart('sendDocument', 'document', chatId, descriptor, caption);
  }
}

async function sendDocument(chatId, descriptor, caption) {
  return sendMediaPart('sendDocument', 'document', chatId, descriptor, caption);
}

async function sendVideo(chatId, descriptor, caption) {
  return sendMediaPart('sendVideo', 'video', chatId, descriptor, caption);
}

async function sendAudio(chatId, descriptor, caption) {
  return sendMediaPart('sendAudio', 'audio', chatId, descriptor, caption);
}

async function sendVoice(chatId, descriptor, caption) {
  return sendMediaPart('sendVoice', 'voice', chatId, descriptor, caption);
}

async function sendAnimation(chatId, descriptor, caption) {
  return sendMediaPart('sendAnimation', 'animation', chatId, descriptor, caption);
}

async function sendMedia(chatId, descriptor, caption) {
  const senders = { image: sendPhoto, animation: sendAnimation, document: sendDocument,
    video: sendVideo, audio: sendAudio, voice: sendVoice };
  const sender = senders[descriptor && descriptor.kind] || sendDocument;
  return sender(chatId, descriptor, caption);
}

module.exports = {
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
};
