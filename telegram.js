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
let lastUpdateId = 0;

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
    console.warn('[telegram] Failed to dump update payload:', err.message);
  }

  const message = body.message || body.edited_message;

  if (!message) {
    console.log('[telegram] Received non-message update, ignoring.');
    return;
  }

  const chatId = message.chat && message.chat.id;
  const text = message.text;
  const caption = message.caption;
  const document = message.document;

  if (!chatId) {
    console.warn('[telegram] Update without chat id, skipping.');
    return;
  }

  if (text) {
    console.log(`[telegram] Received message from chat ${chatId}: "${text}"`);
    await onMessage(chatId, text);
  } else if (document) {
    console.log(`[telegram] Received document from chat ${chatId}: "${document.file_name || document.file_id}"`);
    if (onDocument) {
      await onDocument(chatId, document, caption);
    }
  } else {
    const messageType = getMessageType(message);
    console.log(`[telegram] Received ${messageType} message from chat ${chatId}.`);
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
  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok || !data.ok) {
    throw new Error(ERRORS.telegram.updateFailed(res.status, data));
  }

  for (const update of data.result || []) {
    lastUpdateId = Math.max(lastUpdateId, update.update_id);
    await handleWebhook(update, onMessage, onDocument, onUnsupportedMessage);
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
  const fileInfoRes = await fetch(fileInfoUrl);
  const fileInfo = await fileInfoRes.json();
  if (!fileInfoRes.ok || !fileInfo.ok || !fileInfo.result || !fileInfo.result.file_path) {
    throw new Error(ERRORS.telegram.fileInfoFailed(fileInfoRes.status, fileInfo));
  }

  const downloadUrl = `${API.telegram.fileBaseUrl}/bot${ENV.telegramBotToken}/${fileInfo.result.file_path}`;
  const downloadRes = await fetch(downloadUrl);
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

  console.log(`[telegram] Sending message to chat ${chatId}: "${text}"`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { [HEADERS.contentType]: 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(ERRORS.telegram.sendFailed(res.status, data));
  }

  console.log(`[telegram] Message sent to chat ${chatId}.`);
  return data;
}

module.exports = {
  downloadDocument,
  handleWebhook,
  pollUpdates,
  sendMessage,
};
