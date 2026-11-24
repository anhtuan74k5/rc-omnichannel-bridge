const express = require('express');
const facebook = require('../platforms/facebook');
const { CHANNELS, ENV } = require('../constants/config');
const { forwardToRocketChat } = require('../inbound/forwardToRocketChat');
const { handleFacebookAttachment, enqueueFacebookTask } = require('../inbound/facebook');

const router = express.Router();

router.get('/webhook/facebook', (req, res) => {
  facebook.handleVerify(req, res);
});

router.post('/webhook/facebook', (req, res) => {
  if (ENV.facebookAppSecret
    && !facebook.verifySignature(req.rawBody, req.get('X-Hub-Signature-256'))) {
    console.warn('[facebook] Rejected webhook with missing or invalid signature.');
    return res.sendStatus(401);
  }

  // Acknowledge at once: Meta retries after ~20 s, but AI and Rocket.Chat can be
  // slower than that. The real work continues in the per-customer queue.
  res.sendStatus(200);

  facebook.handleWebhook(
    req.body,
    (psid, text, meta) => enqueueFacebookTask(psid, meta && meta.key, () =>
      forwardToRocketChat(CHANNELS.facebook, psid, `FB ${psid}`, text)),
    (psid, attachment, meta) => enqueueFacebookTask(psid, meta && meta.key, () =>
      handleFacebookAttachment(psid, attachment))
  ).catch((err) => console.error('[facebook] Error handling webhook:', err.message));
});

module.exports = router;
