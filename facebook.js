/**
 * facebook.js
 * -----------
 * Facebook Messenger integration:
 *  - GET  /webhook/facebook : webhook verification (hub.verify_token)
 *  - POST /webhook/facebook : receive incoming messages
 *  - sendMessage()          : send a message back via Graph API v25.0
 */

const { API, ENV, HEADERS } = require('./constants/config');
const { ERRORS } = require('./constants/errors');
const { fetchWithTimeout } = require('./httpClient');
const { log } = require('./logger');

/**
 * Handle GET webhook verification from Facebook.
 * Returns the hub.challenge if hub.verify_token matches FB_VERIFY_TOKEN.
 */
function handleVerify(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  log.info('[facebook] Webhook verify request', { mode });

  if (mode === 'subscribe' && token === ENV.facebookVerifyToken) {
    log.info('[facebook] Webhook verified successfully.');
    res.status(200).send(challenge);
  } else {
    log.warn('[facebook] Webhook verification failed (token mismatch).');
    res.sendStatus(403);
  }
}

/**
 * Handle POST webhook payload from Facebook Messenger.
 * Parses sender PSID and message text, then calls the provided callback.
 *
 * @param {object} body - parsed JSON body
 * @param {function} onMessage - async (psid, text) => void
 */
async function handleWebhook(body, onMessage) {
  if (body.object !== 'page') {
    log.warn('[facebook] Ignoring non-page webhook event.');
    return;
  }

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const psid = event.sender && event.sender.id;
      const message = event.message;

      if (!psid) {
        log.warn('[facebook] Event without sender id, skipping.');
        continue;
      }

      // Only handle text messages for now.
      if (message && message.text) {
        log.info('[facebook] Received message', { psid, type: 'text', length: message.text.length });
        await onMessage(psid, message.text);
      } else {
        log.info('[facebook] Received non-text event', { psid, type: 'unsupported', length: 0 });
      }
    }
  }
}

/**
 * Send a text message to a Facebook user via Graph API.
 * POST https://graph.facebook.com/v25.0/me/messages
 */
async function sendMessage(psid, text) {
  const url = `https://graph.facebook.com/${API.facebook.graphVersion}/me/messages?access_token=${ENV.facebookPageAccessToken}`;
  const body = {
    recipient: { id: psid },
    message: { text },
  };

  log.info('[facebook] Sending message', { psid, type: 'text', length: text.length });
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { [HEADERS.contentType]: 'application/json' },
    body: JSON.stringify(body),
  }, { retries: 0 });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(ERRORS.facebook.sendFailed(res.status, data));
  }

  log.info('[facebook] Message sent', { psid, type: 'text' });
  return data;
}

module.exports = {
  handleVerify,
  handleWebhook,
  sendMessage,
};
