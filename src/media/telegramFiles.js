const fs = require('fs/promises');
const path = require('path');
const { API, ENV } = require('../constants/config');
const { ERRORS } = require('../constants/errors');
const { fetchWithTimeout } = require('../lib/httpClient');

const TELEGRAM_FILE_TOO_LARGE = 'TELEGRAM_FILE_TOO_LARGE';

function createError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * A self-hosted Bot API server in --local mode does not serve files over HTTP:
 * getFile returns the path on its own disk, which the bridge reads from a shared
 * folder. Only files inside TELEGRAM_LOCAL_FILES_DIR are ever opened. Errors
 * never quote the path, because it contains the bot token.
 */
async function readLocalFile(filePath, maxBytes) {
  if (!ENV.telegramLocalFilesDir) throw new Error(ERRORS.telegram.localFileNotConfigured);
  let buffer;
  try {
    const root = await fs.realpath(ENV.telegramLocalFilesDir);
    const file = await fs.realpath(filePath);
    const inside = path.relative(root, file);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
      throw new Error(ERRORS.telegram.localFileOutside);
    }
    const { size } = await fs.stat(file);
    if (size > maxBytes) throw createError(ERRORS.telegram.documentTooLarge(maxBytes), TELEGRAM_FILE_TOO_LARGE);
    buffer = await fs.readFile(file);
  } catch (error) {
    if (error.code === TELEGRAM_FILE_TOO_LARGE || error.message === ERRORS.telegram.localFileOutside) throw error;
    throw new Error(ERRORS.telegram.localFileUnreadable(error.code));
  }
  return { buffer, filePath: path.basename(filePath), size: buffer.length };
}

async function downloadTelegramFile(fileId, { maxBytes = ENV.telegramMaxMediaBytes } = {}) {
  if (!ENV.telegramBotToken) {
    throw new Error(ERRORS.telegram.tokenMissing);
  }
  if (!fileId) {
    throw new Error(ERRORS.telegram.fileInfoFailed(400, { ok: false, description: 'file_id missing' }));
  }

  const fileInfoUrl = `${API.telegram.baseUrl}/bot${ENV.telegramBotToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
  // A local server fetches the file from Telegram during getFile: allow it time.
  const fileInfoRes = await fetchWithTimeout(fileInfoUrl, {}, ENV.telegramLocalFilesDir
    ? { retries: 0, timeoutMs: ENV.httpUploadTimeoutMs }
    : { retries: 2 });
  const fileInfo = await fileInfoRes.json();
  // The cloud Bot API refuses files above its own download limit (20 MB).
  if (/file is too big/i.test(String(fileInfo && fileInfo.description))) {
    throw createError(ERRORS.telegram.documentTooLarge(maxBytes), TELEGRAM_FILE_TOO_LARGE);
  }
  if (!fileInfoRes.ok || !fileInfo.ok || !fileInfo.result || !fileInfo.result.file_path) {
    throw new Error(ERRORS.telegram.fileInfoFailed(fileInfoRes.status, fileInfo));
  }
  if (Number(fileInfo.result.file_size) > maxBytes) {
    throw createError(ERRORS.telegram.documentTooLarge(maxBytes), TELEGRAM_FILE_TOO_LARGE);
  }

  if (path.isAbsolute(fileInfo.result.file_path)) {
    return readLocalFile(fileInfo.result.file_path, maxBytes);
  }

  const downloadUrl = `${API.telegram.fileBaseUrl}/bot${ENV.telegramBotToken}/${fileInfo.result.file_path}`;
  const downloadRes = await fetchWithTimeout(
    downloadUrl,
    {},
    { timeoutMs: ENV.httpUploadTimeoutMs, retries: 2 }
  );
  if (!downloadRes.ok) {
    throw new Error(ERRORS.telegram.fileDownloadFailed(downloadRes.status));
  }

  const buffer = Buffer.from(await downloadRes.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw createError(ERRORS.telegram.documentTooLarge(maxBytes), TELEGRAM_FILE_TOO_LARGE);
  }

  return {
    buffer,
    filePath: fileInfo.result.file_path,
    size: buffer.length,
  };
}

function isTelegramFileTooLarge(error) {
  return error && error.code === TELEGRAM_FILE_TOO_LARGE;
}

module.exports = {
  downloadTelegramFile,
  isTelegramFileTooLarge,
};
