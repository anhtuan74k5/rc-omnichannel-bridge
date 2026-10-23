const { ENV, HEADERS, MIME_TYPES } = require('../constants/config');
const { ERRORS } = require('../constants/errors');
const { fetchWithTimeout } = require('../httpClient');
const { loginAgent } = require('../rocketchat');

const ROCKETCHAT_URL = ENV.rocketchatUrl.replace(/\/+$/, '');

function createError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolveUrl(urlOrPath) {
  const value = String(urlOrPath || '');
  if (/^https?:\/\//i.test(value)) return value;
  return `${ROCKETCHAT_URL}/${value.replace(/^\/+/, '')}`;
}

async function downloadRocketChatFile(urlOrPath) {
  const { authToken, userId } = await loginAgent();
  const response = await fetchWithTimeout(resolveUrl(urlOrPath), {
    headers: {
      [HEADERS.authToken]: authToken,
      [HEADERS.userId]: userId,
    },
  }, { timeoutMs: ENV.httpUploadTimeoutMs, retries: 0 });

  if (response.status === 401) {
    throw createError(ERRORS.rocketchat.fileUnauthorized, 'ROCKETCHAT_FILE_UNAUTHORIZED');
  }
  if (response.status === 403) {
    throw createError(ERRORS.rocketchat.fileForbidden, 'ROCKETCHAT_FILE_FORBIDDEN');
  }
  if (response.status === 404) {
    throw createError(ERRORS.rocketchat.fileNotFound, 'ROCKETCHAT_FILE_NOT_FOUND');
  }
  if (!response.ok) {
    throw createError(ERRORS.rocketchat.fileDownloadFailed(response.status), 'ROCKETCHAT_FILE_DOWNLOAD_FAILED');
  }

  const contentLength = response.headers.get('content-length');
  const declaredSize = contentLength === null ? null : Number(contentLength);
  if (declaredSize !== null && (!Number.isSafeInteger(declaredSize) || declaredSize < 0)) {
    throw createError(ERRORS.rocketchat.fileContentLengthInvalid, 'ROCKETCHAT_FILE_CONTENT_LENGTH_INVALID');
  }
  if (declaredSize !== null && declaredSize > ENV.maxOutboundMediaBytes) {
    throw createError(ERRORS.rocketchat.fileTooLarge(ENV.maxOutboundMediaBytes), 'ROCKETCHAT_FILE_TOO_LARGE');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > ENV.maxOutboundMediaBytes) {
    throw createError(ERRORS.rocketchat.fileTooLarge(ENV.maxOutboundMediaBytes), 'ROCKETCHAT_FILE_TOO_LARGE');
  }

  return {
    buffer,
    mimeType: response.headers.get('content-type') || MIME_TYPES.octetStream,
    filename: urlOrPath.split(/[\\/]/).pop() || 'download',
  };
}

module.exports = { downloadRocketChatFile };
