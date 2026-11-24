const express = require('express');
const mapping = require('../../mapping');
const { ENV } = require('../../constants/config');
const metrics = require('../../metrics');
const { rateLimiter, facebookQueue, rcWebhook } = require('../runtime');

const router = express.Router();

router.get('/health', (req, res) => {
  const m = metrics.snapshot();
  res.json({
    status: 'ok',
    activeRooms: mapping.getActiveEntries().length,
    facebookQueueDepth: facebookQueue.size(),
    lastAgentPollAt: m.lastAgentPollAt || null,
    lastTelegramPollAt: m.lastTelegramPollAt || null,
    rocketChat429: m.rateLimited429,
    customerRateLimited: rateLimiter.limitedTotal(),
    credentialsRejectedAt: {
      facebook: m.facebookAuthRejectedAt || null,
      telegram: m.telegramAuthRejectedAt || null,
    },
    facebookTokenConfigured: Boolean(ENV.facebookPageAccessToken),
    rocketChatWebhook: rcWebhook.status(),
    uptimeSeconds: Math.round((Date.now() - m.startedAt) / 1000),
  });
});

module.exports = router;
