const fs = require('fs');
const path = require('path');

const { ENV } = require('./constants/config');

const DEBUG_DUMPS_DIR = path.join(__dirname, 'debug-dumps');
const ROCKETCHAT_MEDIA_FIELDS = new Set(['file', 'files', 'attachments', 'fileUpload', 't']);
const dumpedIds = new Set();
const MAX_DUMPED_IDS = 5000;
const TELEGRAM_MEDIA_FIELDS = [
  'photo',
  'video',
  'voice',
  'audio',
  'video_note',
  'animation',
  'sticker',
  'document',
];

function redactTokens(value) {
  if (Array.isArray(value)) {
    return value.map(redactTokens);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      key === 'token' ? '***' : redactTokens(nestedValue),
    ])
  );
}

function writeDump(filename, payload) {
  fs.mkdirSync(DEBUG_DUMPS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DEBUG_DUMPS_DIR, filename),
    JSON.stringify(redactTokens(payload), null, 2),
    'utf8'
  );
}

function dumpRocketChatMessage(message) {
  if (!ENV.debugDumpPayloads || !message || typeof message !== 'object') {
    return false;
  }

  const messageId = message._id;
  if (messageId && dumpedIds.has(messageId)) {
    return false;
  }

  const hasMediaField = Object.keys(message).some((field) => ROCKETCHAT_MEDIA_FIELDS.has(field));
  if (!hasMediaField) {
    return false;
  }

  const timestamp = Date.now();
  const filenameId = String(messageId || timestamp).replace(/[^a-zA-Z0-9._-]/g, '_');
  writeDump(`${timestamp}-${filenameId}.json`, message);
  if (messageId) {
    dumpedIds.add(messageId);
    if (dumpedIds.size > MAX_DUMPED_IDS) {
      dumpedIds.delete(dumpedIds.values().next().value);
    }
  }
  return true;
}

function dumpTelegramUpdate(update) {
  if (!ENV.debugDumpPayloads || !update || typeof update !== 'object') {
    return false;
  }

  const message = update.message || update.edited_message;
  const hasMedia = message && TELEGRAM_MEDIA_FIELDS.some((field) => message[field]);
  if (!hasMedia) {
    return false;
  }

  const identifier = update.update_id || Date.now();
  writeDump(`tg-${identifier}.json`, update);
  return true;
}

module.exports = {
  dumpRocketChatMessage,
  dumpTelegramUpdate,
};
