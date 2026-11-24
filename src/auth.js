const crypto = require('crypto');
const { ENV } = require('./constants/config');

function authorizeAdmin(req) {
  if (!ENV.adminApiKey) {
    return { status: 503, message: 'ADMIN_API_KEY is not configured; document endpoints are disabled.' };
  }
  const authorization = String(req.get('Authorization') || '');
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const expected = Buffer.from(ENV.adminApiKey);
  const received = Buffer.from(supplied);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return { status: 401, message: 'Authorization Bearer token is required.' };
  }
  return null;
}

module.exports = { authorizeAdmin };
