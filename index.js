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
const { CHANNELS, DEFAULTS, ENV } = require('./constants/config');
const { MESSAGES } = require('./constants/messages');
const { dumpRocketChatMessage } = require('./debugDump');
const { downloadRocketChatFile, isPermanentDownloadError } = require('./media/rocketchatFiles');
const { downloadTelegramFile, isTelegramFileTooLarge } = require('./media/telegramFiles');


const PORT = ENV.port;
const POLL_INTERVAL_MS = DEFAULTS.pollingIntervalMs;
const TELEGRAM_POLLING_ENABLED = ENV.telegramPollingEnabled;
const TELEGRAM_POLL_INTERVAL_MS = ENV.telegramPollIntervalMs;
const AI_HANDOFF_MESSAGE = ENV.aiHandoffMessage || MESSAGES.ai.handoffDefault;

const app = express();
app.use(express.json({ limit: ENV.requestBodyLimit }));

let telegramPollingInProgress = false;
let agentPollingInProgress = false;
const messageRetryCounts = new Map();
const MAX_PROCESSED_MESSAGE_IDS = 200;
const roomEnsureMutexes = new Map();
const completedAttachmentKeys = new Map();

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
  const key = `${platform}:${String(platformUserId)}`;
  const previous = roomEnsureMutexes.get(key) || Promise.resolve();
  const task = async () => {
    const entry = mapping.getOrCreate(platform, platformUserId);
    const visitorToken = await rocketchat.getOrCreateVisitor(platformUserId, name);
    mapping.update(entry, { visitorToken });

    const roomId = await rocketchat.getOrCreateRoom(visitorToken);
    mapping.update(entry, { roomId });

    return { entry, visitorToken, roomId };
  };
  const current = previous.then(task, task);
  roomEnsureMutexes.set(key, current);
  try {
    return await current;
  } finally {
    if (roomEnsureMutexes.get(key) === current) roomEnsureMutexes.delete(key);
  }
}

async function handleTelegramDocument(chatId, document, caption) {
  try {
    const downloaded = await telegram.downloadDocument(document);
    const result = await documents.uploadDocumentBuffer({
      platform: CHANNELS.telegram,
      platformUserId: chatId,
      filename: downloaded.filename,
      buffer: downloaded.buffer,
    });

    try {
      const { visitorToken, roomId } = await ensureRocketChatRoom(CHANNELS.telegram, chatId, `TG ${chatId}`);
      const description = MESSAGES.bridge.telegramDocumentDescription(
        chatId,
        result.document.chunks
      );
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
          MESSAGES.telegram.uploadedDocumentStatus(
            downloaded.filename,
            downloaded.mimeType,
            formatBytes(downloaded.size),
            result.document.chunks
          )
        );
      } catch (messageErr) {
        console.error(`[rocketchat] Failed to log Telegram document upload for ${chatId}:`, messageErr.message);
      }
    }

    await telegram.sendMessage(
      chatId,
      MESSAGES.telegram.documentUploaded(result.filename, result.document.chunks)
    );

    if (caption && caption.trim()) {
      await forwardToRocketChat(CHANNELS.telegram, chatId, `TG ${chatId}`, caption.trim());
    }
  } catch (err) {
    console.error(`[telegram] Failed to handle document from chat ${chatId}:`, err.message);
    try {
      await telegram.sendMessage(chatId, MESSAGES.telegram.documentUploadFailed);
    } catch (sendErr) {
      console.error(`[telegram] Failed to send document error to chat ${chatId}:`, sendErr.message);
    }
  }
}

async function handleUnsupportedTelegramMessage(chatId, messageType, caption) {
  try {
    const { visitorToken, roomId } = await ensureRocketChatRoom(CHANNELS.telegram, chatId, `TG ${chatId}`);
    const captionText = MESSAGES.bridge.telegramUnsupportedCaption(caption);
    await rocketchat.sendMessageToRocketChat(
      visitorToken,
      roomId,
      MESSAGES.bridge.telegramUnsupportedRoomMessage(messageType, captionText)
    );
    await telegram.sendMessage(
      chatId,
      MESSAGES.telegram.unsupportedMessage
    );
  } catch (err) {
    console.error(`[telegram] Failed to log ${messageType} message from chat ${chatId}:`, err.message);
  }

}

function selectTelegramPhoto(photo) {
  return (Array.isArray(photo) ? photo : [])
    .filter((item) => item && item.file_id)
    .sort((a, b) => Number(b.file_size || 0) - Number(a.file_size || 0)
      || Number(b.width || 0) * Number(b.height || 0) - Number(a.width || 0) * Number(a.height || 0))[0];
}

function getTelegramMediaDescriptor(messageType, media) {
  const timestamp = Date.now();
  if (messageType === 'photo') {
    const photo = selectTelegramPhoto(media);
    if (!photo) throw new Error('Telegram photo has no usable file_id');
    return { fileId: photo.file_id, filename: `photo_${timestamp}.jpg`, mimeType: 'image/jpeg' };
  }
  if (messageType === 'video') {
    return { fileId: media && media.file_id, filename: media && media.file_name || `video_${timestamp}.mp4`, mimeType: media && media.mime_type || 'video/mp4' };
  }
  if (messageType === 'voice') {
    return { fileId: media && media.file_id, filename: `voice_${timestamp}.ogg`, mimeType: 'audio/ogg' };
  }
  if (messageType === 'audio') {
    return { fileId: media && media.file_id, filename: media && (media.file_name || media.title) || `audio_${timestamp}`, mimeType: media && media.mime_type || 'audio/mpeg' };
  }
  if (messageType === 'animation') {
    return { fileId: media && media.file_id, filename: media && media.file_name || `animation_${timestamp}.mp4`, mimeType: 'video/mp4' };
  }
  if (messageType === 'video_note') {
    return { fileId: media && media.file_id, filename: `videonote_${timestamp}.mp4`, mimeType: 'video/mp4' };
  }
  if (messageType === 'sticker' && media && !media.is_animated && !media.is_video) {
    return { fileId: media.file_id, filename: `sticker_${timestamp}.webp`, mimeType: 'image/webp' };
  }
  return null;
}

async function handleTelegramMedia(chatId, messageType, media, caption) {
  const descriptor = getTelegramMediaDescriptor(messageType, media);
  if (!descriptor) {
    await handleUnsupportedTelegramMessage(chatId, messageType, caption);
    return;
  }

  try {
    const downloaded = await downloadTelegramFile(descriptor.fileId, {
      maxBytes: ENV.telegramMaxMediaBytes,
    });
    const { visitorToken, roomId } = await ensureRocketChatRoom(CHANNELS.telegram, chatId, `TG ${chatId}`);
    await rocketchat.uploadLivechatFile(visitorToken, roomId, {
      filename: descriptor.filename,
      buffer: downloaded.buffer,
      mimeType: descriptor.mimeType,
    });
    if (caption && caption.trim()) {
      await forwardToRocketChat(CHANNELS.telegram, chatId, `TG ${chatId}`, caption.trim());
    }
  } catch (err) {
    console.error(`[telegram] Failed to handle ${messageType} from chat ${chatId}:`, err.message);
    try {
      await telegram.sendMessage(
        chatId,
        isTelegramFileTooLarge(err)
          ? MESSAGES.telegram.mediaTooLarge
          : MESSAGES.telegram.mediaUploadFailed
      );
    } catch (sendErr) {
      console.error(`[telegram] Failed to send ${messageType} error notice:`, sendErr.message);
    }
    try {
      const { visitorToken, roomId } = await ensureRocketChatRoom(CHANNELS.telegram, chatId, `TG ${chatId}`);
      await rocketchat.sendMessageToRocketChat(
        visitorToken,
        roomId,
        MESSAGES.telegram.mediaUploadStatus(messageType, descriptor.filename, err.message)
      );
    } catch (roomErr) {
      console.error(`[rocketchat] Failed to log ${messageType} upload error:`, roomErr.message);
    }
    if (!isTelegramFileTooLarge(err)) throw err;
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
      await rocketchat.sendMessageToRocketChat(
        visitorToken,
        roomId,
        MESSAGES.bridge.aiReplyForRoom(aiReply)
      );
      try {
        await sendReplyToPlatform(platform, platformUserId, aiReply);
      } catch (err) {
        console.error(`[${platform}] Failed to send AI reply back to platform:`, err.message);
      }
    } else if (ai.isEnabled()) {
      await rocketchat.sendMessageToRocketChat(
        visitorToken,
        roomId,
        MESSAGES.bridge.aiHandoffForRoom(AI_HANDOFF_MESSAGE)
      );
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
          MESSAGES.routing.failed
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
    }, handleTelegramDocument, handleUnsupportedTelegramMessage, handleTelegramMedia);
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
    }, handleTelegramDocument, handleUnsupportedTelegramMessage, handleTelegramMedia);
  } catch (err) {
    console.error('[telegram] Error polling updates:', err.message);
  } finally {
    telegramPollingInProgress = false;
  }
}

async function pollAgentMessages() {
  if (agentPollingInProgress) return;
  agentPollingInProgress = true;

  try {
  const entries = mapping.getActiveEntries().filter((entry) => entry.roomId && entry.visitorToken);
  if (entries.length === 0) return;

  for (const entry of entries) {
    try {
      const newMessages = await rocketchat.pollNewAgentMessages(
        entry.roomId,
        entry.visitorToken,
        entry.lastMessageTimestamp,
        entry.processedMessageIds || []
      );

      for (const msg of newMessages) {
        try {
          dumpRocketChatMessage(msg);
        } catch (err) {
          console.warn('[poll] Failed to dump message payload:', err.message);
        }

        const text = msg.msg;
        const ts = new Date(msg.ts).getTime();
        const messageId = msg._id;
        const retryKey = `${entry.platform}:${entry.platformUserId}:${messageId || `${ts}:${text || ''}`}`;
        const attachments = rocketchat.extractAttachments(msg);
        const completed = completedAttachmentKeys.get(retryKey) || new Set();
        const pendingAttachments = attachments.filter((attachment) => !completed.has(attachment.source));

        if (entry.platform === 'telegram' && attachments.length > 0 && text !== 'connected') {
          let attachmentFailed = false;
          for (const attachment of pendingAttachments) {
            const attachmentRetryKey = `${retryKey}:${attachment.source}`;
            try {
              const downloaded = await downloadRocketChatFile(attachment.source);
              await telegram.sendMedia(entry.platformUserId, {
                ...attachment,
                buffer: downloaded.buffer,
                mimeType: downloaded.mimeType || attachment.mimeType,
                filename: downloaded.filename || attachment.filename,
                size: downloaded.buffer.length,
              }, completed.size === 0 ? text : '');
              completed.add(attachment.source);
              messageRetryCounts.delete(attachmentRetryKey);
            } catch (err) {
              console.error(`[poll] Failed to forward attachment ${attachment.filename} to Telegram:`, err.message);
              const permanent = isPermanentDownloadError(err);
              const retries = (messageRetryCounts.get(attachmentRetryKey) || 0) + 1;
              if (permanent || retries >= ENV.rocketChatMaxMessageRetries) {
                completed.add(attachment.source);
                messageRetryCounts.delete(attachmentRetryKey);
              } else {
                messageRetryCounts.set(attachmentRetryKey, retries);
                attachmentFailed = true;
              }
              try {
                await telegram.sendMessage(entry.platformUserId, MESSAGES.telegram.mediaDeliveryFailed);
              } catch (noticeErr) {
                console.error('[poll] Failed to send attachment error notice:', noticeErr.message);
              }
              if (attachmentFailed) break;
            }
          }
          if (attachmentFailed) {
            completedAttachmentKeys.set(retryKey, completed);
            continue;
          }
          completedAttachmentKeys.delete(retryKey);
          messageRetryCounts.delete(retryKey);
          markMessageProcessed(entry, messageId, ts);
          continue;
        }

        if (!text || text === 'connected') {
          markMessageProcessed(entry, messageId, ts);
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
          messageRetryCounts.delete(retryKey);
          markMessageProcessed(entry, messageId, ts);
        } catch (err) {
          console.error(`[poll] Failed to forward message ${msg._id} to ${entry.platform}:`, err.message);
          const retries = (messageRetryCounts.get(retryKey) || 0) + 1;
          messageRetryCounts.set(retryKey, retries);
          if (retries >= ENV.rocketChatMaxMessageRetries) {
            console.error(`[poll] Giving up on message ${msg._id} after ${retries} attempts.`);
            messageRetryCounts.delete(retryKey);
            markMessageProcessed(entry, messageId, ts);
          } else {
            break;
          }
        }
      }
    } catch (err) {
      console.error(`[poll] Error polling room ${entry.roomId}:`, err.message);
    }

    function markMessageProcessed(entry, messageId, timestamp) {
      const processedMessageIds = Array.isArray(entry.processedMessageIds)
        ? entry.processedMessageIds.filter((id) => id !== messageId)
        : [];
      if (messageId) processedMessageIds.push(messageId);
      entry.processedMessageIds = processedMessageIds.slice(-MAX_PROCESSED_MESSAGE_IDS);
      entry.lastMessageTimestamp = Math.max(entry.lastMessageTimestamp || 0, timestamp);
      mapping.update(entry, {
        lastMessageTimestamp: entry.lastMessageTimestamp,
        processedMessageIds: entry.processedMessageIds,
      });
    }
  }
  } finally {
    agentPollingInProgress = false;
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
