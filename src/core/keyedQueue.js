/**
 * keyedQueue.js
 * -------------
 * In-memory work queue that runs tasks one at a time per key and in parallel
 * across keys. Used so a webhook can be acknowledged immediately while each
 * customer's messages are still processed strictly in arrival order.
 */

function createKeyedQueue({ onError } = {}) {
  const tails = new Map();
  const idleWaiters = [];
  let pending = 0;

  function settle() {
    if (pending !== 0) return;
    for (const resolve of idleWaiters.splice(0)) resolve(true);
  }

  function enqueue(key, task) {
    pending += 1;
    const previous = tails.get(key) || Promise.resolve();
    const run = previous
      .then(task)
      .catch((error) => {
        if (onError) onError(error, key);
      })
      .finally(() => {
        pending -= 1;
        if (tails.get(key) === run) tails.delete(key);
        settle();
      });
    tails.set(key, run);
    return run;
  }

  /** Resolves true when the queue drains, or false after `timeoutMs`. */
  function idle(timeoutMs = 10000) {
    if (pending === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      idleWaiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  return { enqueue, idle, size: () => pending };
}

module.exports = { createKeyedQueue };
