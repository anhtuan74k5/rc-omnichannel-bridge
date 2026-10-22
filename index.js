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
const ai = require('./ai');
const documents = require('./documents');


const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MS = 3000;
const TELEGRAM_POLLING_ENABLED = process.env.TELEGRAM_POLLING === 'true';
const TELEGRAM_POLL_INTERVAL_MS = Number(process.env.TELEGRAM_POLL_INTERVAL_MS || 2000);
const AI_HANDOFF_MESSAGE = process.env.AI_HANDOFF_MESSAGE
  || 'Mình chưa có đủ thông tin để trả lời chính xác câu hỏi này. Mình đã chuyển nội dung cho nhân viên hỗ trợ, bạn vui lòng chờ trong giây lát nhé.';

const app = express();
app.use(express.json({ limit: process.env.REQUEST_BODY_LIMIT || '2mb' }));

let telegramPollingInProgress = false;

// ============================================================
// Shared handler: incoming platform message -> Rocket.Chat
// ============================================================

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Send a reply back to the correct platform (Facebook or Telegram).
 */
async function sendReplyToPlatform(platform, platformUserId, text) {
  if (platform === 'facebook') {
    await facebook.sendMessage(platformUserId, text);
  } else if (platform === 'telegram') {
    await telegram.sendMessage(platformUserId, text);
  }
}

async function ensureRocketChatRoom(platform, platformUserId, name) {
  const entry = mapping.getOrCreate(platform, platformUserId);
  const visitorToken = await rocketchat.getOrCreateVisitor(platformUserId, name);
  mapping.update(entry, { visitorToken });

  const roomId = await rocketchat.getOrCreateRoom(visitorToken);
  mapping.update(entry, { roomId });

  return { entry, visitorToken, roomId };
}

async function handleTelegramDocument(chatId, document, caption) {
  try {
    const downloaded = await telegram.downloadDocument(document);
    const result = await documents.uploadDocumentBuffer({
      platform: 'telegram',
      platformUserId: chatId,
      filename: downloaded.filename,
      buffer: downloaded.buffer,
    });

    try {
      const { visitorToken, roomId } = await ensureRocketChatRoom('telegram', chatId, `TG ${chatId}`);
      const description = `Telegram document from TG ${chatId}. Indexed for AI with ${result.document.chunks} chunk(s).`;
      await rocketchat.uploadLivechatFile(visitorToken, roomId, {
        filename: downloaded.filename,
        buffer: downloaded.buffer,
        mimeType: downloaded.mimeType,
        description,
      });
    } catch (syncErr) {
      console.error(`[rocketchat] Failed to upload Telegram document to room for ${chatId}:`, syncErr.message);
      try {
        const { visitorToken, roomId } = await ensureRocketChatRoom('telegram', chatId, `TG ${chatId}`);
        await rocketchat.sendMessageToRocketChat(
          visitorToken,
          roomId,
          `📎 Telegram uploaded document: ${downloaded.filename} (${downloaded.mimeType}, ${formatBytes(downloaded.size)}). Indexed for AI with ${result.document.chunks} chunk(s), but Rocket.Chat file upload failed: ${syncErr.message}`
        );
      } catch (messageErr) {
        console.error(`[rocketchat] Failed to log Telegram document upload for ${chatId}:`, messageErr.message);
      }
    }

    await telegram.sendMessage(
      chatId,
      `Đã upload tài liệu "${result.filename}" (${result.document.chunks} đoạn). Bạn có thể hỏi mình theo tài liệu này.`
    );

    if (caption && caption.trim()) {
      await forwardToRocketChat('telegram', chatId, `TG ${chatId}`, caption.trim());
    }
  } catch (err) {
    console.error(`[telegram] Failed to handle document from chat ${chatId}:`, err.message);
    try {
      await telegram.sendMessage(chatId, `Chưa upload được tài liệu: ${err.message}`);
    } catch (sendErr) {
      console.error(`[telegram] Failed to send document error to chat ${chatId}:`, sendErr.message);
    }
  }
}

async function handleUnsupportedTelegramMessage(chatId, messageType, caption) {
  try {
    const { visitorToken, roomId } = await ensureRocketChatRoom('telegram', chatId, `TG ${chatId}`);
    const captionText = caption && caption.trim()
      ? ` Caption: "${caption.trim()}"`
      : '';
    await rocketchat.sendMessageToRocketChat(
      visitorToken,
      roomId,
      `[Telegram ${messageType}] User sent a ${messageType} message.${captionText} This bridge currently forwards text and supported documents only.`
    );
    await telegram.sendMessage(
      chatId,
      'Mình đã nhận được nội dung bạn gửi, nhưng hiện tại bot chỉ đọc được tin nhắn văn bản và tài liệu PDF/DOCX/text. Nhân viên hỗ trợ có thể xem thông báo này trong hệ thống.'
    );
  } catch (err) {
    console.error(`[telegram] Failed to log ${messageType} message from chat ${chatId}:`, err.message);
  }
}

/**
 * Given a platform user id, name and platform, ensure the visitor + room
 * exist on Rocket.Chat, then send the message into the room.
 *
 * AI integration: before routing to a human agent, ask the AI if it can
 * handle the message automatically. If yes, the AI reply is sent to the
 * customer AND logged into the Rocket.Chat room (so the agent sees the full
 * AI conversation in Omnichannel). If no (or AI disabled), hand off to agent.
 */
async function forwardToRocketChat(platform, platformUserId, name, text) {

  // 0. Try AI auto-reply first (if enabled).
  let aiReply = null;
  if (ai.isEnabled()) {
    try {
      const decision = await ai.askAI(text, { platform, platformUserId });
      if (decision.handled && decision.reply) {
        aiReply = decision.reply;
        console.log(`[ai] AI auto-replied to ${platform}:${platformUserId}: "${aiReply}"`);
      } else {
        console.log(`[ai] AI cannot handle, handing off to agent for ${platform}:${platformUserId}.`);
      }
    } catch (err) {
      console.error('[ai] AI call failed, falling back to agent:', err.message);
    }
  }

  try {
    const { visitorToken, roomId } = await ensureRocketChatRoom(platform, platformUserId, name);

    // 4. Send the visitor message into the room.
    await rocketchat.sendMessageToRocketChat(visitorToken, roomId, text);

    // 5. If AI handled it, also send the AI reply into the room so the agent
    //    can see the full AI conversation in Omnichannel, AND send it to the
    //    customer on the platform.
    if (aiReply) {
      await rocketchat.sendMessageToRocketChat(visitorToken, roomId, `🤖 AI: ${aiReply}`);
      try {
        await sendReplyToPlatform(platform, platformUserId, aiReply);
      } catch (err) {
        console.error(`[${platform}] Failed to send AI reply back to platform:`, err.message);
      }
    } else if (ai.isEnabled()) {
      await rocketchat.sendMessageToRocketChat(visitorToken, roomId, `🤖 AI: ${AI_HANDOFF_MESSAGE}`);
      try {
        await sendReplyToPlatform(platform, platformUserId, AI_HANDOFF_MESSAGE);
      } catch (err) {
        console.error(`[${platform}] Failed to send handoff notice back to platform:`, err.message);
      }
    }
  } catch (err) {
    if (!aiReply) {
      console.error(`[rocketchat] Failed to route message for ${platform}:${platformUserId}:`, err.message);
      try {
        await sendReplyToPlatform(
          platform,
          platformUserId,
          'Mình đã nhận được tin nhắn của bạn, nhưng hiện chưa kết nối được hệ thống hỗ trợ. Bạn vui lòng thử lại sau ít phút nhé.'
        );
      } catch (sendErr) {
        console.error(`[${platform}] Failed to send routing error notice:`, sendErr.message);
      }
      return;
    }

    console.error(
      '[rocketchat] Failed to log AI-handled message, sending platform reply only:',
      err.message
    );
    try {
      await sendReplyToPlatform(platform, platformUserId, aiReply);
    } catch (sendErr) {
      console.error(`[${platform}] Failed to send AI reply back to platform:`, sendErr.message);
    }
  }
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
    }, handleTelegramDocument, handleUnsupportedTelegramMessage);
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
// Document upload routes (MVP local RAG)
// ============================================================

app.post('/documents/upload', (req, res) => {
  try {
    const result = documents.uploadDocument(req.body || {});
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[documents] Upload failed:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/documents', (req, res) => {
  try {
    const { platform, platformUserId } = req.query;
    const result = documents.listDocuments(platform, platformUserId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[documents] List failed:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ============================================================
// Polling loop: forward agent messages to the correct platform
// ============================================================

async function pollTelegramUpdates() {
  if (telegramPollingInProgress) return;
  telegramPollingInProgress = true;
  try {
    await telegram.pollUpdates(async (chatId, text) => {
      await forwardToRocketChat('telegram', chatId, `TG ${chatId}`, text);
    }, handleTelegramDocument, handleUnsupportedTelegramMessage);
  } catch (err) {
    console.error('[telegram] Error polling updates:', err.message);
  } finally {
    telegramPollingInProgress = false;
  }
}

async function pollAgentMessages() {
  const entries = mapping.getActiveEntries().filter((entry) => entry.roomId && entry.visitorToken);
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
        const ts = new Date(msg.ts).getTime();
        if (!text || text === 'connected') {
          mapping.update(entry, { lastMessageTimestamp: Math.max(entry.lastMessageTimestamp, ts) });
          continue;
        }

        console.log(
          `[poll] New agent message in room ${entry.roomId} -> ${entry.platform}:${entry.platformUserId}: "${text}"`
        );

        try {
          if (entry.platform === 'facebook') {
            await facebook.sendMessage(entry.platformUserId, text);
          } else if (entry.platform === 'telegram') {
            await telegram.sendMessage(entry.platformUserId, text);
          }
        } catch (err) {
          console.error(`[poll] Failed to forward message ${msg._id} to ${entry.platform}:`, err.message);
        }

        // Update last seen timestamp so we don't re-send this message.
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
  }


  app.listen(PORT, () => {
    console.log(`[startup] Bridge server listening on port ${PORT}`);
    console.log(`[startup] Facebook webhook:  http://localhost:${PORT}/webhook/facebook`);
    console.log(`[startup] Telegram webhook:  http://localhost:${PORT}/webhook/telegram`);
  });
}

start();
