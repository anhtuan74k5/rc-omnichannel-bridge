/**
 * Startup: load state, log in to Rocket.Chat, start the polling loops and the
 * HTTP server, and drain queued work on shutdown.
 */

const mapping = require('./core/mapping');
const rocketchat = require('./rocketchat/rocketchat');
const facebook = require('./platforms/facebook');
const telegram = require('./platforms/telegram');
const ai = require('./knowledge/ai');
const { ENV } = require('./constants/config');
const { app } = require('./app');
const { facebookQueue, rcWebhook } = require('./runtime');
const { pollAgentMessages } = require('./outbound/pollAgentMessages');
const { pollTelegramUpdates } = require('./inbound/pollTelegram');

const PORT = ENV.port;
const POLL_INTERVAL_MS = ENV.rocketChatPollIntervalMs;
const TELEGRAM_POLLING_ENABLED = ENV.telegramPollingEnabled;
const TELEGRAM_POLL_INTERVAL_MS = ENV.telegramPollIntervalMs;

async function start() {
  // Load persisted mapping.
  mapping.load();

  // Verify required env vars are present. Use either a Personal Access Token
  // pair or username/password credentials for the Rocket.Chat agent.
  const hasPersonalAccessToken = process.env.ROCKETCHAT_AUTH_TOKEN && process.env.ROCKETCHAT_USER_ID;
  const required = hasPersonalAccessToken
    ? ['ROCKETCHAT_URL', 'ROCKETCHAT_AUTH_TOKEN', 'ROCKETCHAT_USER_ID']
    : ['ROCKETCHAT_URL', 'ROCKETCHAT_AGENT_USERNAME', 'ROCKETCHAT_AGENT_PASSWORD'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`[startup] Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Pre-login the agent so the first webhook is fast.
  try {
    await rocketchat.loginAgent();
  } catch (err) {
    console.error('[startup] Initial agent login failed:', err.message);
    console.error('[startup] Check ROCKETCHAT_URL / credentials and try again.');
    process.exit(1);
  }

  // Start the polling loop.
  setInterval(pollAgentMessages, POLL_INTERVAL_MS);
  console.log(`[startup] Polling loop started (every ${POLL_INTERVAL_MS / 1000}s).`);
  console.log(`[startup] AI bot: ${ai.isEnabled() ? 'ENABLED' : 'disabled'}`);

  if (TELEGRAM_POLLING_ENABLED) {
    setInterval(pollTelegramUpdates, TELEGRAM_POLL_INTERVAL_MS);
    console.log(`[startup] Telegram polling enabled (every ${TELEGRAM_POLL_INTERVAL_MS / 1000}s).`);
  } else if (!ENV.telegramWebhookSecret) {
    console.warn('[startup] TELEGRAM_WEBHOOK_SECRET is not set while Telegram polling is disabled; webhook requests are unauthenticated.');
  }


  const server = app.listen(PORT, () => {
    console.log(`[startup] Bridge server listening on port ${PORT}`);
    if (!ENV.facebookAppSecret) {
      console.warn('[startup] FB_APP_SECRET is not set; Facebook webhook signatures are NOT verified.');
    }
    console.log(`[startup] Facebook webhook:  http://localhost:${PORT}/webhook/facebook`);
    console.log(`[startup] Telegram webhook:  http://localhost:${PORT}/webhook/telegram`);
    console.log(`[startup] Rocket.Chat webhook: ${rcWebhook.isEnabled() ? `http://localhost:${PORT}/webhook/rocketchat` : 'disabled (ROCKETCHAT_WEBHOOK_SECRET not set)'}`);
    // Informational only: failures are logged, never fatal.
    facebook.checkToken().catch(() => {});
    telegram.checkToken().catch(() => {});
  });

  // Let queued Facebook work finish before exiting so acknowledged messages
  // are not lost on a normal stop or restart.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received; draining ${facebookQueue.size()} queued task(s).`);
    server.close();
    const drained = await facebookQueue.idle(10000);
    if (!drained) console.warn('[shutdown] Timed out; some queued tasks were dropped.');
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { start };
