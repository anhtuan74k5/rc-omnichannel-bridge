const { ENV, HEADERS, MIME_TYPES } = require('../constants/config');
const { ERRORS } = require('../constants/errors');
const { fetchWithTimeout } = require('../lib/httpClient');
const { loginAgent } = require('../rocketchat/rocketchat');
const { rocketChatFilePath } = require('./rocketchatFileUrl');

const ROCKETCHAT_URL = ENV.rocketchatUrl.replace(/\/+$/, '');

function createError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const MAX_REDIRECTS = 3;

function resolveUrl(urlOrPath) {
  const path = rocketChatFilePath(urlOrPath);
  if (!path) throw createError(ERRORS.rocketchat.fileUrlRejected, 'ROCKETCHAT_FILE_URL_REJECTED');
  return `${ROCKETCHAT_URL}${path}`;
}

/**
 * GET with the agent's headers, following redirects by hand: external file
 * storage (S3, GCS) must never receive the Rocket.Chat credentials.
 */
async function fetchRocketChatFile(url, authHeaders) {
  const home = new URL(url).origin;
  let target = url;
  for (let hop = 0; ; hop += 1) {
    const response = await fetchWithTimeout(target, {
      headers: new URL(target).origin === home ? authHeaders : {},
      redirect: 'manual',
    }, { timeoutMs: ENV.httpUploadTimeoutMs, retries: 0 });
    const location = response.status >= 300 && response.status < 400 && response.headers.get('location');
    if (!location || hop >= MAX_REDIRECTS) return response;
    target = new URL(location, target).toString();
  }
}

function isPermanentDownloadError(error) {
  return [
    'ROCKETCHAT_FILE_UNAUTHORIZED',
    'ROCKETCHAT_FILE_FORBIDDEN',
    'ROCKETCHAT_FILE_NOT_FOUND',
    'ROCKETCHAT_FILE_TOO_LARGE',
    'ROCKETCHAT_FILE_CONTENT_LENGTH_INVALID',
    'ROCKETCHAT_FILE_URL_REJECTED',
  ].includes(error && error.code);
}

async function downloadRocketChatFile(urlOrPath) {
  const { authToken, userId } = await loginAgent();
  const response = await fetchRocketChatFile(resolveUrl(urlOrPath), {
    [HEADERS.authToken]: authToken,
    [HEADERS.userId]: userId,
  });

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

module.exports = { downloadRocketChatFile, isPermanentDownloadError };
