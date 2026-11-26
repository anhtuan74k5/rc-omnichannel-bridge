const { ENV } = require('../constants/config');
const { ERRORS } = require('../constants/errors');
const { fetchWithTimeout } = require('../lib/httpClient');
const { filenameFromUrl } = require('./facebookFiles');

const ZALO_FILE_TOO_LARGE = 'ZALO_FILE_TOO_LARGE';

function createError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Only fetch attachments from Zalo's CDNs (SSRF guard). An entry starting with
 * a dot matches that domain's hosts over https; a full origin (the local mock)
 * must match exactly.
 */
function isAllowedZaloMediaUrl(value, allowed = ENV.zaloMediaHosts) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  return allowed.some((rule) => (rule.startsWith('.')
    ? url.protocol === 'https:' && url.hostname.toLowerCase().endsWith(rule)
    : url.origin === rule));
}

async function downloadZaloMedia(url, { maxBytes = ENV.zaloMaxMediaBytes, filename, fallbackName = 'zalo_file' } = {}) {
  if (!isAllowedZaloMediaUrl(url)) {
    throw createError(ERRORS.zalo.mediaUrlRejected, 'ZALO_MEDIA_URL_REJECTED');
  }
  // Never follow redirects: an allowed host must not bounce us to an internal address.
  const res = await fetchWithTimeout(url, { redirect: 'manual' }, { timeoutMs: ENV.httpUploadTimeoutMs, retries: 2 });
  if (!res.ok) throw new Error(ERRORS.zalo.mediaDownloadFailed(res.status));

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw createError(ERRORS.zalo.mediaTooLarge(maxBytes), ZALO_FILE_TOO_LARGE);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw createError(ERRORS.zalo.mediaTooLarge(maxBytes), ZALO_FILE_TOO_LARGE);

  const mimeType = (res.headers.get('content-type') || 'application/octet-stream').split(';', 1)[0].trim();
  return { buffer, mimeType, filename: filename || filenameFromUrl(url, mimeType, fallbackName, buffer) };
}

const isZaloFileTooLarge = (error) => Boolean(error) && error.code === ZALO_FILE_TOO_LARGE;

module.exports = { downloadZaloMedia, isAllowedZaloMediaUrl, isZaloFileTooLarge };
