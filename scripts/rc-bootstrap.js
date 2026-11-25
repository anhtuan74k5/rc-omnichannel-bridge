#!/usr/bin/env node
/**
 * Prepare a fresh Rocket.Chat for the bridge. Safe to run any number of times:
 * every step checks the current state first.
 *
 *   1. Log in as the admin created by the Rocket.Chat container (ADMIN_USERNAME/ADMIN_PASS).
 *   2. Turn on Omnichannel and stop new users from being opted into e-mail 2FA
 *      (the bridge logs in with a password and cannot answer an e-mail code).
 *   3. Create the agent account the bridge logs in with and make it an Omnichannel agent.
 *   4. Point the Omnichannel webhook at the bridge when ROCKETCHAT_WEBHOOK_SECRET is set.
 *
 * Environment: ROCKETCHAT_URL, RC_ADMIN_USERNAME, RC_ADMIN_PASSWORD,
 *   ROCKETCHAT_AGENT_USERNAME, ROCKETCHAT_AGENT_PASSWORD, [RC_AGENT_NAME], [RC_AGENT_EMAIL],
 *   [ROCKETCHAT_WEBHOOK_SECRET], [RC_WEBHOOK_URL].
 * Secrets are never printed.
 */

const BASE = String(process.env.ROCKETCHAT_URL || 'http://rocketchat:3000').replace(/\/+$/, '');
const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

let auth = null;

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) Object.assign(headers, { 'X-Auth-Token': auth.authToken, 'X-User-Id': auth.userId });
  const res = await fetch(`${BASE}/api/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const error = new Error(`${method} ${path} failed (${res.status}): ${data.error || data.message || 'no details'}`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function waitForServer() {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      // /api/info (no v1) answers without login once the server is up.
      const res = await fetch(`${BASE}/api/info`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return;
      throw new Error(`HTTP ${res.status}`);
    } catch {
      if (attempt === 1) console.log(`[bootstrap] Waiting for Rocket.Chat at ${BASE} ...`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  throw new Error('Rocket.Chat did not answer within 5 minutes');
}

/** True when these credentials log in (uses its own request, not the admin session). */
async function canLogIn(user, password) {
  const res = await fetch(`${BASE}/api/v1/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, password }),
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!res || !res.ok) return false;
  const data = await res.json().catch(() => ({}));
  return data.status === 'success';
}

async function setSetting(id, value) {
  const current = await api('GET', `settings/${id}`).catch(() => null);
  if (current && current.value === value) return false;
  await api('POST', `settings/${id}`, { value });
  return true;
}

async function ensureAgent() {
  const username = need('ROCKETCHAT_AGENT_USERNAME');
  const password = need('ROCKETCHAT_AGENT_PASSWORD');
  let user = await api('GET', `users.info?username=${encodeURIComponent(username)}`)
    .then((data) => data.user)
    .catch((error) => (error.status === 400 || error.status === 404 ? null : Promise.reject(error)));

  if (!user) {
    ({ user } = await api('POST', 'users.create', {
      username,
      password,
      name: process.env.RC_AGENT_NAME || username,
      email: process.env.RC_AGENT_EMAIL || `${username}@example.com`,
      verified: true,
      requirePasswordChange: false,
      joinDefaultChannels: false,
      sendWelcomeEmail: false,
      roles: ['user', 'livechat-agent'],
    }));
    console.log(`[bootstrap] Created user "${username}".`);
  } else {
    // .env is the source of truth for the bridge's password: keep Rocket.Chat in step,
    // otherwise a changed ROCKETCHAT_AGENT_PASSWORD makes the bridge fail to log in.
    const works = await canLogIn(username, password);
    if (works) {
      console.log(`[bootstrap] User "${username}" already exists.`);
    } else {
      await api('POST', 'users.update', { userId: user._id, data: { password } });
      console.log(`[bootstrap] User "${username}" existed with another password; updated it to the one in .env.`);
    }
  }

  const agents = await api('GET', 'livechat/users/agent?count=200');
  if (!agents.users.some((agent) => agent.username === username)) {
    await api('POST', 'livechat/users/agent', { username });
    console.log(`[bootstrap] "${username}" is now an Omnichannel agent.`);
  }
  return user;
}

async function main() {
  await waitForServer();
  try {
    auth = (await api('POST', 'login', {
      user: process.env.RC_ADMIN_USERNAME || 'admin',
      password: need('RC_ADMIN_PASSWORD'),
    })).data;
  } catch (error) {
    // RC_ADMIN_PASSWORD only applies on Rocket.Chat's first start. If the admin password
    // was changed later but the bridge's agent still logs in, do not block the bridge.
    const agentOk = await canLogIn(process.env.ROCKETCHAT_AGENT_USERNAME, process.env.ROCKETCHAT_AGENT_PASSWORD);
    if (agentOk) {
      console.warn(`[bootstrap] Admin login failed (${error.message}); the agent account works, so setup is skipped.`);
      console.warn('[bootstrap] Set RC_ADMIN_PASSWORD to the current admin password to let setup check Rocket.Chat again.');
      return;
    }
    throw error;
  }
  console.log('[bootstrap] Logged in as admin.');

  const changed = [];
  if (await setSetting('Livechat_enabled', true)) changed.push('Livechat_enabled');
  if (await setSetting('Accounts_TwoFactorAuthentication_By_Email_Auto_Opt_In', false)) {
    changed.push('Accounts_TwoFactorAuthentication_By_Email_Auto_Opt_In');
  }

  await ensureAgent();

  const secret = process.env.ROCKETCHAT_WEBHOOK_SECRET;
  if (secret) {
    const url = process.env.RC_WEBHOOK_URL || 'http://bridge:3001/webhook/rocketchat';
    const settings = {
      Livechat_webhookUrl: url,
      Livechat_secret_token: secret,
      Livechat_webhook_on_close: true,
      Livechat_webhook_on_visitor_message: true,
      Livechat_webhook_on_agent_message: true,
    };
    for (const [id, value] of Object.entries(settings)) {
      if (await setSetting(id, value)) changed.push(id);
    }
  } else {
    console.log('[bootstrap] ROCKETCHAT_WEBHOOK_SECRET is empty; webhook left off (the bridge polls).');
  }

  console.log(changed.length
    ? `[bootstrap] Settings updated: ${changed.join(', ')}`
    : '[bootstrap] Settings already correct.');
  console.log('[bootstrap] Done.');
}

main().catch((error) => {
  console.error(`[bootstrap] ${error.message}`);
  process.exit(1);
});
