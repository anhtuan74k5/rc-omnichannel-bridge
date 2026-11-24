/**
 * facebookProfile.js
 * ------------------
 * Looks up a Messenger customer's display name (User Profile API). Needs the
 * page to have the permission; any failure returns null so callers fall back
 * to `FB <psid>`.
 */

const { API, ENV } = require('./constants/config');
const { fetchWithTimeout } = require('./httpClient');
const { log } = require('./logger');

async function fetchProfileName(psid) {
  if (!ENV.facebookPageAccessToken) return null;
  const url = `https://graph.facebook.com/${API.facebook.graphVersion}/${encodeURIComponent(psid)}?fields=name`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${ENV.facebookPageAccessToken}` },
    }, { retries: 0, timeoutMs: 5000 });
    if (!res.ok) {
      log.warn('[facebook] Profile lookup refused', { psid, status: res.status });
      return null;
    }
    const data = await res.json();
    const name = data && typeof data.name === 'string' ? data.name.trim() : '';
    return name || null;
  } catch (err) {
    log.warn('[facebook] Profile lookup failed', { psid, error: err.message });
    return null;
  }
}

module.exports = { fetchProfileName };
