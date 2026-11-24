const { ENV } = require('../constants/config');
const { ERRORS } = require('../constants/errors');
const { fetchWithTimeout } = require('../httpClient');

const FACEBOOK_FILE_TOO_LARGE = 'FACEBOOK_FILE_TOO_LARGE';
const FACEBOOK_URL_REJECTED = 'FACEBOOK_MEDIA_URL_REJECTED';
const ALLOWED_HOST_SUFFIXES = ['.fbcdn.net', '.fbsbx.com', '.facebook.com'];

const EXTENSIONS_BY_MIME = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/ogg': '.ogg',
  'application/pdf': '.pdf',
});

function createError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Only fetch attachment URLs that really point at Facebook's CDN (SSRF guard). */
function isAllowedFacebookMediaUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** Guess an extension from the first bytes when neither the URL nor the MIME type names one. */
function sniffExtension(buffer) {
  if (!buffer || buffer.length < 12) return '';
  const ascii = (from, to) => buffer.toString('latin1', from, to);
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return '.wav';
  if (ascii(4, 8) === 'ftyp') return ascii(8, 12).startsWith('M4A') ? '.m4a' : '.mp4';
  if (ascii(0, 4) === 'OggS') return '.ogg';
  if (ascii(0, 3) === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return '.mp3';
  if (ascii(0, 4) === '%PDF') return '.pdf';
  if (ascii(0, 4) === 'PK\u0003\u0004') return '.zip';
  if (buffer[0] === 0x89 && ascii(1, 4) === 'PNG') return '.png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return '.jpg';
  if (ascii(0, 3) === 'GIF') return '.gif';
  return '';
}

function filenameFromUrl(value, mimeType, fallbackBase, buffer) {
  let name = '';
  try {
    name = decodeURIComponent(new URL(value).pathname.split('/').pop() || '');
  } catch {
    name = '';
  }
  if (/\.[A-Za-z0-9]{1,5}$/.test(name)) return name;
  const base = String(mimeType || '').split(';', 1)[0].trim().toLowerCase();
  return `${fallbackBase}${EXTENSIONS_BY_MIME[base] || sniffExtension(buffer)}`;
}

async function downloadFacebookAttachment(url, { maxBytes = ENV.facebookMaxMediaBytes, fallbackName = 'facebook_file' } = {}) {
  if (!isAllowedFacebookMediaUrl(url)) {
    throw createError(ERRORS.facebook.mediaUrlRejected, FACEBOOK_URL_REJECTED);
  }

  // Never follow redirects: an allowed CDN host must not bounce us to an internal address.
  const res = await fetchWithTimeout(url, { redirect: 'manual' }, { timeoutMs: ENV.httpUploadTimeoutMs, retries: 2 });
  if (!res.ok) throw new Error(ERRORS.facebook.mediaDownloadFailed(res.status));

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw createError(ERRORS.facebook.mediaTooLarge(maxBytes), FACEBOOK_FILE_TOO_LARGE);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw createError(ERRORS.facebook.mediaTooLarge(maxBytes), FACEBOOK_FILE_TOO_LARGE);
  }

  const mimeType = (res.headers.get('content-type') || 'application/octet-stream').split(';', 1)[0].trim();
  return {
    buffer,
    mimeType,
    filename: filenameFromUrl(url, mimeType, fallbackName, buffer),
    size: buffer.length,
  };
}

function isFacebookFileTooLarge(error) {
  return Boolean(error) && error.code === FACEBOOK_FILE_TOO_LARGE;
}

module.exports = {
  downloadFacebookAttachment,
  sniffExtension,
  isAllowedFacebookMediaUrl,
  isFacebookFileTooLarge,
};
