/**
 * rateLimiter.js
 * --------------
 * Sliding-window limiter keyed by `platform:userId`. `check` reports whether
 * a message may pass and whether the customer should be told (once per burst).
 */

function createRateLimiter({ limit = 20, windowMs = 60000, now = Date.now } = {}) {
  const hits = new Map(); // key -> { times: number[], notified: boolean }
  let limitedTotal = 0;

  function check(key) {
    if (!(limit > 0)) return { allowed: true, notify: false };
    const t = now();
    const state = hits.get(key) || { times: [], notified: false };
    state.times = state.times.filter((time) => t - time < windowMs);
    if (state.times.length >= limit) {
      limitedTotal += 1;
      const notify = !state.notified;
      state.notified = true;
      hits.set(key, state);
      return { allowed: false, notify };
    }
    state.times.push(t);
    state.notified = false;
    hits.set(key, state);
    return { allowed: true, notify: false };
  }

  /** Drop idle keys so the map cannot grow without bound. */
  function sweep() {
    const t = now();
    for (const [key, state] of hits) {
      if (state.times.every((time) => t - time >= windowMs)) hits.delete(key);
    }
  }

  return { check, sweep, limitedTotal: () => limitedTotal, size: () => hits.size };
}

module.exports = { createRateLimiter };
