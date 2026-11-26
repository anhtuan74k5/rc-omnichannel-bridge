const express = require('express');
const zalo = require('../platforms/zalo');
const { CHANNELS, ENV } = require('../constants/config');
const { forwardToRocketChat } = require('../inbound/forwardToRocketChat');
const { enqueueInboundTask } = require('../inbound/queue');
const { handleZaloAttachment } = require('../inbound/zalo');

const router = express.Router();

router.post('/webhook/zalo', (req, res) => {
  if (!ENV.zaloEnabled) return res.sendStatus(404);
  if (!zalo.verifySignature(req.rawBody, req.get('X-ZEvent-Signature'), req.body && req.body.timestamp)) {
    console.warn('[zalo] Rejected webhook with missing or invalid signature.');
    return res.sendStatus(401);
  }
  // Acknowledge at once; the work continues in the per-customer queue.
  res.sendStatus(200);

  const enqueue = (userId, meta, task) => enqueueInboundTask(CHANNELS.zalo, userId, meta && meta.key, task);
  zalo.handleWebhook(
    req.body,
    (userId, text, meta) => enqueue(userId, meta, () =>
      forwardToRocketChat(CHANNELS.zalo, userId, `Zalo ${userId}`, text)),
    (userId, attachment, meta) => enqueue(userId, meta, () => handleZaloAttachment(userId, attachment))
  ).catch((err) => console.error('[zalo] Error handling webhook:', err.message));
});

module.exports = router;
