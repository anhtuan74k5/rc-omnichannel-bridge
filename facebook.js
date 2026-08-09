/**
 * facebook.js
 * -----------
 * Facebook Messenger integration:
 *  - GET  /webhook/facebook : webhook verification (hub.verify_token)
 *  - POST /webhook/facebook : receive incoming messages
 *  - sendMessage()          : send a message back via Graph API v25.0
 */

const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const FB_GRAPH_VERSION = 'v25.0';

/**
 * Handle GET webhook verification from Facebook.
 * Returns the hub.challenge if hub.verify_token matches FB_VERIFY_TOKEN.
 */
function handleVerify(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log(`[facebook] Webhook verify request: mode=${mode}, token=${token}`);

  if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
    console.log('[facebook] Webhook verified successfully.');
    res.status(200).send(challenge);
  } else {
    console.warn('[facebook] Webhook verification FAILED (token mismatch).');
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
    console.warn('[facebook] Ignoring non-page webhook event.');
    return;
  }

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const psid = event.sender && event.sender.id;
      const message = event.message;

      if (!psid) {
        console.warn('[facebook] Event without sender id, skipping.');
        continue;
      }

      // Only handle text messages for now.
      if (message && message.text) {
        console.log(`[facebook] Received message from PSID ${psid}: "${message.text}"`);
        await onMessage(psid, message.text);
      } else {
        console.log(`[facebook] Received non-text event from PSID ${psid}, ignoring.`);
      }
    }
  }
}

/**
 * Send a text message to a Facebook user via Graph API.
 * POST https://graph.facebook.com/v25.0/me/messages
 */
async function sendMessage(psid, text) {
  const url = `https://graph.facebook.com/${FB_GRAPH_VERSION}/me/messages?access_token=${FB_PAGE_ACCESS_TOKEN}`;
  const body = {
    recipient: { id: psid },
    message: { text },
  };

  console.log(`[facebook] Sending message to PSID ${psid}: "${text}"`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Facebook send failed (${res.status}): ${JSON.stringify(data)}`);
  }

  console.log(`[facebook] Message sent to PSID ${psid}.`);
  return data;
}

module.exports = {
  handleVerify,
  handleWebhook,
  sendMessage,
};
