const { API, ENV } = require('../constants/config');
const { ERRORS } = require('../constants/errors');
const { fetchWithTimeout } = require('../httpClient');

const TELEGRAM_FILE_TOO_LARGE = 'TELEGRAM_FILE_TOO_LARGE';

function createError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function downloadTelegramFile(fileId, { maxBytes = ENV.telegramMaxMediaBytes } = {}) {
  if (!ENV.telegramBotToken) {
    throw new Error(ERRORS.telegram.tokenMissing);
  }
  if (!fileId) {
    throw new Error(ERRORS.telegram.fileInfoFailed(400, { ok: false, description: 'file_id missing' }));
  }

  const fileInfoUrl = `${API.telegram.baseUrl}/bot${ENV.telegramBotToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const fileInfoRes = await fetchWithTimeout(fileInfoUrl, {}, { retries: 2 });
  const fileInfo = await fileInfoRes.json();
  if (!fileInfoRes.ok || !fileInfo.ok || !fileInfo.result || !fileInfo.result.file_path) {
    throw new Error(ERRORS.telegram.fileInfoFailed(fileInfoRes.status, fileInfo));
  }
  if (Number(fileInfo.result.file_size) > maxBytes) {
    throw createError(ERRORS.telegram.documentTooLarge(maxBytes), TELEGRAM_FILE_TOO_LARGE);
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
