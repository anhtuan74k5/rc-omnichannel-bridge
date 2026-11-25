/**
 * Shared singletons: the queues, rate limiter, poll scheduler and the
 * Rocket.Chat webhook handler used by more than one module.
 */

const mapping = require('./core/mapping');
const { ENV } = require('./constants/config');
const { createKeyedQueue } = require('./core/keyedQueue');
const { createRocketChatWebhook } = require('./rocketchat/rcWebhook');
const { createPollScheduler } = require('./rocketchat/pollScheduler');
const { createRateLimiter } = require('./core/rateLimiter');

const rateLimiter = createRateLimiter({ limit: ENV.rateLimitPerMinute, windowMs: 60000 });
setInterval(() => rateLimiter.sweep(), 5 * 60000).unref();

const pollScheduler = createPollScheduler({ hotWindowMs: ENV.rocketChatHotWindowMs });
const facebookQueue = createKeyedQueue({
  onError: (err, key) => console.error(`[facebook] Background task failed for ${key}:`, err.message),
});
const facebookInFlight = new Set();
// Agent messages reach the customer through one queue per customer, whether they
// come from polling or from the Rocket.Chat webhook.
const agentDeliveryQueue = createKeyedQueue({
  onError: (err, key) => console.error(`[poll] Delivery task failed for ${key}:`, err.message),
});
const rcWebhook = createRocketChatWebhook({
  secret: ENV.rocketChatWebhookSecret,
  silenceMs: ENV.rocketChatWebhookSilenceMs,
  fallbackPollMs: ENV.rocketChatWebhookFallbackPollMs,
  findEntry: (event) => mapping.findByRoomId(event.roomId),
  // Required lazily: outbound/deliverAgentMessages itself depends on this module.
  deliver: (entry, messages, closed) =>
    require('./outbound/deliverAgentMessages').deliverAgentMessages(entry, messages, closed),
  onUrgent: (entry) => pollScheduler.prioritize(entry),
  onError: (err) => console.error('[rc-webhook] Failed to process event:', err.message),
});

module.exports = { rateLimiter, pollScheduler, facebookQueue, facebookInFlight, agentDeliveryQueue, rcWebhook };
