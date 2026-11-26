/**
 * The per-customer task queue behind the webhooks that are acknowledged first
 * (Messenger, Zalo).
 */

const mapping = require('../core/mapping');
// One queue for all of them; the keys carry the platform, and shutdown drains it.
const { facebookQueue: inboundQueue, facebookInFlight: inFlight } = require('../runtime');

/**
 * Queue one message part. Parts of the same customer run in order; different
 * customers run in parallel. A part already seen (the platform redelivers a
 * webhook it considers unanswered) is dropped, also across restarts.
 */
function enqueueInboundTask(platform, userId, dedupeKey, task) {
  const id = dedupeKey ? `${platform}:${userId}:${dedupeKey}` : null;
  if (id) {
    const entry = mapping.getOrCreate(platform, userId);
    if (inFlight.has(id) || mapping.hasProcessedInbound(entry, dedupeKey)) {
      console.log(`[${platform}] Duplicate delivery ignored.`);
      return;
    }
    inFlight.add(id);
  }

  const queuedAt = Date.now();
  inboundQueue.enqueue(`${platform}:${userId}`, async () => {
    try {
      console.log(`[timing] ${platform}:${userId} queue-wait=${Date.now() - queuedAt}ms`);
      await task();
    } finally {
      if (id) {
        inFlight.delete(id);
        mapping.markInboundProcessed(mapping.getOrCreate(platform, userId), dedupeKey);
      }
    }
  });
}

module.exports = { enqueueInboundTask };
