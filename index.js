/**
 * index.js
 * --------
 * Bridge server entry point.
 *
 * Exposes:
 *  - GET  /webhook/facebook  (Facebook webhook verification)
 *  - POST /webhook/facebook  (Facebook incoming messages)
 *  - POST /webhook/telegram  (Telegram incoming messages)
 *
 * Runs a polling loop every 3 seconds that checks each active Rocket.Chat
 * room for new agent messages and forwards them to the correct platform.
 */

require('dotenv').config();

const express = require('express');

const mapping = require('./mapping');
const rocketchat = require('./rocketchat');
const facebook = require('./facebook');
const telegram = require('./telegram');

const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MS = 3000;

const app = express();
app.use(express.json());

// ============================================================
// Shared handler: incoming platform message -> Rocket.Chat
// ============================================================

/**
 * Given a platform user id, name and platform, ensure the visitor + room
 * exist on Rocket.Chat, then send the message into the room.
 */
async function forwardToRocketChat(platform, platformUserId, name, text) {
  // 1. Get or create the mapping entry (persisted in mapping.json).
  const entry = mapping.getOrCreate(platform, platformUserId);

  // 2. Get or create the visitor on Rocket.Chat.
  const visitorToken = await rocketchat.getOrCreateVisitor(platformUserId, name);
  mapping.update(entry, { visitorToken });

  // 3. Get or create the room.
  const roomId = await rocketchat.getOrCreateRoom(visitorToken);
  mapping.update(entry, { roomId });

  // 4. Send the visitor message into the room.
  await rocketchat.sendMessageToRocketChat(visitorToken, roomId, text);
}

// ============================================================
// Facebook webhook routes
// ============================================================

app.get('/webhook/facebook', (req, res) => {
  facebook.handleVerify(req, res);
});

app.post('/webhook/facebook', async (req, res) => {
  try {
    await facebook.handleWebhook(req.body, async (psid, text) => {
      await forwardToRocketChat('facebook', psid, `FB ${psid}`, text);
    });
    res.sendStatus(200);
  } catch (err) {
    console.error('[facebook] Error handling webhook:', err.message);
    res.sendStatus(500);
  }
});

// ============================================================
// Telegram webhook route
// ============================================================

app.post('/webhook/telegram', async (req, res) => {
  try {
    await telegram.handleWebhook(req.body, async (chatId, text) => {
      await forwardToRocketChat('telegram', chatId, `TG ${chatId}`, text);
    });
    res.sendStatus(200);
  } catch (err) {
    console.error('[telegram] Error handling webhook:', err.message);
    res.sendStatus(500);
  }
});

// ============================================================
// Health check
// ============================================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', activeRooms: mapping.getActiveEntries().length });
});

// ============================================================
// Polling loop: forward agent messages to the correct platform
// ============================================================

async function pollAgentMessages() {
  const entries = mapping.getActiveEntries();
  if (entries.length === 0) return;

  for (const entry of entries) {
    try {
      const newMessages = await rocketchat.pollNewAgentMessages(
        entry.roomId,
        entry.visitorToken,
        entry.lastMessageTimestamp
      );

      for (const msg of newMessages) {
        const text = msg.msg;
        if (!text) continue;

        console.log(
          `[poll] New agent message in room ${entry.roomId} -> ${entry.platform}:${entry.platformUserId}: "${text}"`
        );

        if (entry.platform === 'facebook') {
          await facebook.sendMessage(entry.platformUserId, text);
        } else if (entry.platform === 'telegram') {
          await telegram.sendMessage(entry.platformUserId, text);
        }

        // Update last seen timestamp so we don't re-send this message.
        const ts = new Date(msg.ts).getTime();
        mapping.update(entry, { lastMessageTimestamp: Math.max(entry.lastMessageTimestamp, ts) });
      }
    } catch (err) {
      console.error(`[poll] Error polling room ${entry.roomId}:`, err.message);
    }
  }
}

// ============================================================
// Startup
// ============================================================

async function start() {
  // Load persisted mapping.
  mapping.load();

  // Verify required env vars are present.
  const required = [
    'ROCKETCHAT_URL',
    'ROCKETCHAT_AGENT_USERNAME',
    'ROCKETCHAT_AGENT_PASSWORD',
  ];
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

  app.listen(PORT, () => {
    console.log(`[startup] Bridge server listening on port ${PORT}`);
    console.log(`[startup] Facebook webhook:  http://localhost:${PORT}/webhook/facebook`);
    console.log(`[startup] Telegram webhook:  http://localhost:${PORT}/webhook/telegram`);
  });
}

start();
