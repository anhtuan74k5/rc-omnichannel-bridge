/**
 * metrics.js
 * ----------
 * Tiny in-process counters and a stage timer. Nothing here holds secrets or
 * message content.
 */

const state = {
  rateLimited429: 0,
  lastAgentPollAt: 0,
  lastTelegramPollAt: 0,
  startedAt: Date.now(),
};

function inc(name, by = 1) { state[name] = (state[name] || 0) + by; }
function set(name, value) { state[name] = value; }
function snapshot() { return { ...state }; }

/** Stage timer: mark('rc') records ms since the previous mark. */
function createTimer(now = Date.now) {
  const start = now();
  let last = start;
  const stages = [];
  return {
    mark(name) {
      const t = now();
      stages.push([name, t - last]);
      last = t;
    },
    summary() {
      return `${stages.map(([name, ms]) => `${name}=${ms}ms`).join(' ')} total=${now() - start}ms`;
    },
  };
}

module.exports = { inc, set, snapshot, createTimer };
