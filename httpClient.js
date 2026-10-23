const { ENV } = require('./constants/config');

const RETRYABLE_STATUS = (status) => status === 429 || status >= 500;

function isRetryableError(error) {
  return error && (
    error.name === 'AbortError'
    || error.name === 'TypeError'
    || error.code === 'UND_ERR_CONNECT_TIMEOUT'
    || error.code === 'ECONNRESET'
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryAfterMs(response) {
  if (response.status !== 429) return 0;
  return response
    .clone()
    .json()
    .then((body) => {
      const retryAfter = body && body.parameters && Number(body.parameters.retry_after);
      return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
    })
    .catch(() => 0);
}

async function fetchWithTimeout(url, options = {}, policy = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const timeoutMs = policy.timeoutMs || ENV.httpTimeoutMs;
  const retries = Math.max(0, Number(policy.retries || 0));
  const canRetryMethod = !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || policy.retryNonIdempotent === true;
  const retryOn = policy.retryOn || RETRYABLE_STATUS;
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (attempt >= retries || !canRetryMethod || !(await retryOn(response.status, response))) {
        clearTimeout(timeout);
        return response;
      }

      const retryAfterMs = await getRetryAfterMs(response);
      const exponentialMs = Math.min(1000 * (2 ** attempt), 10000);
      const jitterMs = Math.floor(Math.random() * 250);
      clearTimeout(timeout);
      await wait(Math.max(retryAfterMs, exponentialMs + jitterMs));
    } catch (error) {
      clearTimeout(timeout);
      if (attempt >= retries || !canRetryMethod || (!isRetryableError(error) && !timedOut)) {
        throw error;
      }
      const exponentialMs = Math.min(1000 * (2 ** attempt), 10000);
      await wait(exponentialMs + Math.floor(Math.random() * 250));
    }
  }
}

module.exports = { fetchWithTimeout };
