/**
 * telegram.js
 * -----------
 * Telegram Bot integration:
 *  - POST /webhook/telegram : receive incoming messages
 *  - pollUpdates()          : receive incoming messages via getUpdates polling
 *  - sendMessage()          : send a message back via Bot API
 */

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_MAX_DOCUMENT_BYTES = Number(process.env.TELEGRAM_MAX_DOCUMENT_BYTES || 100 * 1024 * 1024);
const SUPPORTED_DOCUMENT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.csv',
  '.tsv',
  '.json',
  '.jsonl',
  '.html',
  '.htm',
  '.xml',
  '.yaml',
  '.yml',
  '.log',
  '.ini',
  '.conf',
  '.env',
  '.pdf',
  '.docx',
]);
let lastUpdateId = 0;

function getExtension(filename) {
  const match = String(filename || '').toLowerCase().match(/\.[^.]+$/);
  return match ? match[0] : '';
}

function getMessageType(message) {
  const types = [
    'photo',
    'sticker',
    'voice',
    'audio',
    'video',
    'video_note',
    'animation',
    'contact',
    'location',
    'venue',
  ];

  return types.find((type) => message[type]) || 'unsupported';
}

/**
 * Handle POST webhook payload from Telegram Bot API.
 * Parses chat_id and message text, then calls the provided callback.
 *
 * @param {object} body - parsed JSON body
 * @param {function} onMessage - async (chatId, text) => void
 */
async function handleWebhook(body, onMessage, onDocument, onUnsupportedMessage) {
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
  if (!TELEGRAM_BOT_TOKEN) return;

  const params = new URLSearchParams({
    timeout: '0',
    allowed_updates: JSON.stringify(['message', 'edited_message']),
  });
  if (lastUpdateId > 0) {
    params.set('offset', String(lastUpdateId + 1));
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?${params.toString()}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok || !data.ok) {
    throw new Error(`Telegram getUpdates failed (${res.status}): ${JSON.stringify(data)}`);
  }

  for (const update of data.result || []) {
    lastUpdateId = Math.max(lastUpdateId, update.update_id);
    await handleWebhook(update, onMessage, onDocument, onUnsupportedMessage);
  }
}

async function downloadDocument(document) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is missing');
  }

  const filename = document.file_name || 'document.txt';
  const extension = getExtension(filename);
  if (!SUPPORTED_DOCUMENT_EXTENSIONS.has(extension)) {
    throw new Error(
      `Unsupported document type "${extension || 'unknown'}". Please upload one of: ${Array.from(SUPPORTED_DOCUMENT_EXTENSIONS).join(', ')}.`
    );
  }

  if (document.file_size && document.file_size > TELEGRAM_MAX_DOCUMENT_BYTES) {
    throw new Error(`Document is too large. Max size is ${TELEGRAM_MAX_DOCUMENT_BYTES} bytes.`);
  }

  const fileInfoUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(document.file_id)}`;
  const fileInfoRes = await fetch(fileInfoUrl);
  const fileInfo = await fileInfoRes.json();
  if (!fileInfoRes.ok || !fileInfo.ok || !fileInfo.result || !fileInfo.result.file_path) {
    throw new Error(`Telegram getFile failed (${fileInfoRes.status}): ${JSON.stringify(fileInfo)}`);
  }

  const downloadUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`;
  const downloadRes = await fetch(downloadUrl);
  if (!downloadRes.ok) {
    throw new Error(`Telegram file download failed (${downloadRes.status})`);
  }

  const buffer = Buffer.from(await downloadRes.arrayBuffer());
  if (buffer.length > TELEGRAM_MAX_DOCUMENT_BYTES) {
    throw new Error(`Document is too large. Max size is ${TELEGRAM_MAX_DOCUMENT_BYTES} bytes.`);
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
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
  };

  console.log(`[telegram] Sending message to chat ${chatId}: "${text}"`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram send failed (${res.status}): ${JSON.stringify(data)}`);
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
