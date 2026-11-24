/**
 * webhookGuards.js
 * ----------------
 * Decide whether a Telegram webhook request may proceed.
 * Returns an HTTP status to reject with, or null to accept.
 */

const crypto = require('crypto');

function telegramWebhookRejection({ pollingEnabled, secret, header }) {
  // Updates arrive through getUpdates; an open webhook would only be an extra door.
  if (pollingEnabled) return 404;
  if (!secret) return null;
  const expected = Buffer.from(secret);
  const received = Buffer.from(String(header || ''));
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return 401;
  return null;
}

module.exports = { telegramWebhookRejection };
