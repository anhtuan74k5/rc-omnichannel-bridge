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
const crypto = require('crypto');

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
const { downloadFacebookAttachment, isFacebookFileTooLarge } = require('./media/facebookFiles');
const { classifyDeliveryError } = require('./deliveryErrors');
const { createKeyedQueue } = require('./keyedQueue');
const { callsPerTick, createPollScheduler } = require('./pollScheduler');
const { createRateLimiter } = require('./rateLimiter');
const { resolveCustomerName } = require('./customerNames');
const { telegramWebhookRejection } = require('./webhookGuards');
const metrics = require('./metrics');


const PORT = ENV.port;
const POLL_INTERVAL_MS = ENV.rocketChatPollIntervalMs;
const TELEGRAM_POLLING_ENABLED = ENV.telegramPollingEnabled;
const TELEGRAM_POLL_INTERVAL_MS = ENV.telegramPollIntervalMs;
const AI_HANDOFF_MESSAGE = ENV.aiHandoffMessage || MESSAGES.ai.handoffDefault;

const app = express();
// Keep the raw bytes: Facebook's X-Hub-Signature-256 is computed over them.
const keepRawBody = (req, res, buf) => { req.rawBody = buf; };
// Only the admin upload may be large; the first parser to run wins.
app.use('/documents/upload', express.json({ limit: ENV.requestBodyLimit, verify: keepRawBody }));
app.use(express.json({ limit: ENV.webhookBodyLimit, verify: keepRawBody }));

const rateLimiter = createRateLimiter({ limit: ENV.rateLimitPerMinute, windowMs: 60000 });
setInterval(() => rateLimiter.sweep(), 5 * 60000).unref();

let telegramPollingInProgress = false;
let agentPollingInProgress = false;
let rocketChatPollingNotBefore = 0;
const messageRetryCounts = new Map();
const MAX_PROCESSED_MESSAGE_IDS = 200;
const roomEnsureMutexes = new Map();
const completedAttachmentKeys = new Map();
const pollScheduler = createPollScheduler({ hotWindowMs: ENV.rocketChatHotWindowMs });
const facebookQueue = createKeyedQueue({
  onError: (err, key) => console.error(`[facebook] Background task failed for ${key}:`, err.message),
});
const facebookInFlight = new Set();

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

/** True while a human owns the conversation and the AI must not answer. */
function isAiPaused(entry) {
  if (!entry) return false;
  const last = Math.max(Number(entry.aiHandoffAt) || 0, Number(entry.agentActiveAt) || 0);
  return last > 0 && Date.now() - last < ENV.aiResumeAfterMs;
}

/** Tell the agent, inside the room, that a message could not reach the customer. */
async function notifyDeliveryFailure(entry, what, reason) {
  try {
    await rocketchat.sendMessageToRocketChat(
      entry.visitorToken,
      entry.roomId,
      MESSAGES.bridge.deliveryFailed(entry.platform, what, reason)
    );
  } catch (err) {
    console.error('[poll] Failed to tell the agent about a delivery failure:', err.message);
  }
}

async function ensureRocketChatRoom(platform, platformUserId, name) {
  const key = `${platform}:${String(platformUserId)}`;
  const previous = roomEnsureMutexes.get(key) || Promise.resolve();
  const task = async () => {
    const entry = mapping.getOrCreate(platform, platformUserId);
    // The name only matters while the visitor is created; skip lookups afterwards.
    const visitorName = entry.visitorToken ? name : await resolveCustomerName(platform, platformUserId, name);
    const visitorToken = await rocketchat.getOrCreateVisitor(platformUserId, visitorName);
    // lastInboundAt marks the room "hot" so the poller serves it more often.
    mapping.update(entry, { visitorToken, lastInboundAt: Date.now() });

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

const FACEBOOK_MEDIA_TYPES = new Set(['image', 'video', 'audio', 'file']);

/**
 * Facebook attachment -> Rocket.Chat room. Images, videos, audio and files are
 * downloaded from Meta's CDN and uploaded; locations become a map link.
 */
async function handleFacebookAttachment(psid, attachment) {
  const type = attachment && attachment.type;
  const name = `FB ${psid}`;
  const url = attachment && attachment.payload && attachment.payload.url;

  try {
    if (type === 'location') {
      const coords = attachment.payload && attachment.payload.coordinates;
      if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.long)) {
        const mapUrl = `https://www.google.com/maps?q=${coords.lat},${coords.long}`;
        const { visitorToken, roomId } = await ensureRocketChatRoom(CHANNELS.facebook, psid, name);
        await rocketchat.sendMessageToRocketChat(
          visitorToken, roomId, MESSAGES.facebook.locationRoomMessage(attachment.title, mapUrl)
        );
        return;
      }
    }

    if (!FACEBOOK_MEDIA_TYPES.has(type) || !url) {
      const { visitorToken, roomId } = await ensureRocketChatRoom(CHANNELS.facebook, psid, name);
      await rocketchat.sendMessageToRocketChat(
        visitorToken, roomId, MESSAGES.facebook.unsupportedRoomMessage(type || 'unknown')
      );
      return;
    }
  } catch (err) {
    console.error(`[facebook] Failed to log ${type} from ${psid}:`, err.message);
    return;
  }

  let filename = `${type}_${Date.now()}`;
  try {
    const downloaded = await downloadFacebookAttachment(url, {
      maxBytes: ENV.facebookMaxMediaBytes,
      fallbackName: filename,
    });
    filename = downloaded.filename;
    const { visitorToken, roomId } = await ensureRocketChatRoom(CHANNELS.facebook, psid, name);
    await rocketchat.uploadLivechatFile(visitorToken, roomId, {
      filename,
      buffer: downloaded.buffer,
      mimeType: downloaded.mimeType,
    });
  } catch (err) {
    console.error(`[facebook] Failed to handle ${type} from ${psid}:`, err.message);
    try {
      await facebook.sendMessage(
        psid,
        isFacebookFileTooLarge(err) ? MESSAGES.facebook.mediaTooLarge : MESSAGES.facebook.mediaUploadFailed
      );
    } catch (sendErr) {
      console.error(`[facebook] Failed to send ${type} error notice:`, sendErr.message);
    }
    try {
      const { visitorToken, roomId } = await ensureRocketChatRoom(CHANNELS.facebook, psid, name);
      await rocketchat.sendMessageToRocketChat(
        visitorToken, roomId, MESSAGES.facebook.mediaUploadStatus(type, filename, err.message)
      );
    } catch (roomErr) {
      console.error(`[rocketchat] Failed to log ${type} upload error:`, roomErr.message);
    }
  }
}

/**
 * Send one Rocket.Chat attachment to the customer's platform. Telegram carries
 * the caption natively; Messenger has no captions, so the text follows as a
 * separate message (its failure is logged, not retried, to avoid re-sending
 * the file).
 */
async function sendAttachmentToPlatform(platform, platformUserId, descriptor, caption) {
  if (platform === 'telegram') {
    await telegram.sendMedia(platformUserId, descriptor, caption, { markdown: true });
    return;
  }
  await facebook.sendMedia(platformUserId, descriptor);
  if (caption && caption.trim()) {
    try {
      await facebook.sendAgentMessage(platformUserId, caption, { timeZone: ENV.timezone });
    } catch (err) {
      console.error('[facebook] Failed to send attachment caption:', err.message);
    }
  }
}

function mediaDeliveryFailedMessage(platform) {
  return platform === 'facebook' ? MESSAGES.facebook.mediaDeliveryFailed : MESSAGES.telegram.mediaDeliveryFailed;
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
async function forwardToRocketChat(platform, platformUserId, name, text, options = {}) {
  const timer = metrics.createTimer();
  try {
    await forwardToRocketChatInner(platform, platformUserId, name, text, options, timer);
  } finally {
    console.log(`[timing] ${platform}:${platformUserId} ${timer.summary()}`);
  }
}

async function forwardToRocketChatInner(platform, platformUserId, name, text, options, timer) {
  const known = mapping.findByPlatformUser(platform, platformUserId);

  // Per-customer rate limit: skip the message (and the AI) once a customer floods.
  const limit = rateLimiter.check(`${platform}:${platformUserId}`);
  if (!limit.allowed) {
    console.warn(`[ratelimit] Dropping message from ${platform}:${platformUserId}.`);
    if (limit.notify) {
      try {
        await sendReplyToPlatform(platform, platformUserId, MESSAGES.routing.rateLimited);
      } catch (err) {
        console.error(`[${platform}] Failed to send rate-limit notice:`, err.message);
      }
    }
    return;
  }

  // A customer edited an earlier message: show the agent the new text, but do
  // not run the AI or reply again.
  if (options.edited) {
    try {
      const { visitorToken, roomId } = await ensureRocketChatRoom(platform, platformUserId, name);
      await rocketchat.sendMessageToRocketChat(visitorToken, roomId, MESSAGES.bridge.editedForRoom(text));
    } catch (err) {
      console.error(`[rocketchat] Failed to forward an edited message for ${platform}:${platformUserId}:`, err.message);
    }
    return;
  }

  // `/bot` hands the conversation back to the AI.
  if (ai.isEnabled() && /^\/bot$/i.test(String(text).trim())) {
    if (known) mapping.update(known, { aiHandoffAt: 0, agentActiveAt: 0 });
    try {
      const { visitorToken, roomId } = await ensureRocketChatRoom(platform, platformUserId, name);
      await rocketchat.sendMessageToRocketChat(visitorToken, roomId, MESSAGES.ai.resumedForRoom);
    } catch (err) {
      console.error(`[rocketchat] Failed to log AI resume for ${platform}:${platformUserId}:`, err.message);
    }
    try {
      await sendReplyToPlatform(platform, platformUserId, MESSAGES.ai.resumed);
    } catch (err) {
      console.error(`[${platform}] Failed to confirm AI resume:`, err.message);
    }
    return;
  }

  // Once a human is involved the AI stays out of the way (until it times out or
  // the customer types /bot), otherwise it would answer between agent messages.
  const aiPaused = ai.isEnabled() && isAiPaused(known);

  // 0. Try AI auto-reply first (if enabled and not paused).
  let aiReply = null;
  let aiDeclined = false;
  if (ai.isEnabled() && !aiPaused) {
    try {
      const decision = await ai.askAI(text, { platform, platformUserId });
      if (decision.handled && decision.reply) {
        aiReply = decision.reply;
        console.log(`[ai] AI auto-replied to ${platform}:${platformUserId}.`);
      } else {
        aiDeclined = true;
        console.log(`[ai] AI cannot handle, handing off to agent for ${platform}:${platformUserId}.`);
      }
    } catch (err) {
      console.error('[ai] AI call failed, falling back to agent:', err.message);
    }
  }

  timer.mark('ai');
  try {
    const { visitorToken, roomId } = await ensureRocketChatRoom(platform, platformUserId, name);

    // 4. Send the visitor message into the room.
    await rocketchat.sendMessageToRocketChat(visitorToken, roomId, text);
    timer.mark('rocketchat');

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
        timer.mark('reply');
      } catch (err) {
        console.error(`[${platform}] Failed to send AI reply back to platform:`, err.message);
      }
    } else if (ai.isEnabled() && !aiPaused) {
      // Tell the customer once; from now on messages go straight to the agent.
      await rocketchat.sendMessageToRocketChat(
        visitorToken,
        roomId,
        MESSAGES.bridge.aiHandoffForRoom(AI_HANDOFF_MESSAGE)
      );
      if (aiDeclined) {
        const entry = mapping.findByPlatformUser(platform, platformUserId);
        if (entry) mapping.update(entry, { aiHandoffAt: Date.now() });
      }
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

/**
 * Queue one Facebook message part. Parts of the same customer run in order;
 * different customers run in parallel. A part already seen (Meta redelivers a
 * webhook it considers unanswered) is dropped, also across restarts.
 */
function enqueueFacebookTask(psid, dedupeKey, task) {
  const id = dedupeKey ? `${psid}:${dedupeKey}` : null;
  if (id) {
    const entry = mapping.getOrCreate(CHANNELS.facebook, psid);
    if (facebookInFlight.has(id) || mapping.hasProcessedInbound(entry, dedupeKey)) {
      console.log('[facebook] Duplicate delivery ignored.');
      return;
    }
    facebookInFlight.add(id);
  }

  const queuedAt = Date.now();
  facebookQueue.enqueue(`facebook:${psid}`, async () => {
    try {
      console.log(`[timing] facebook:${psid} queue-wait=${Date.now() - queuedAt}ms`);
      await task();
    } finally {
      if (id) {
        facebookInFlight.delete(id);
        mapping.markInboundProcessed(mapping.getOrCreate(CHANNELS.facebook, psid), dedupeKey);
      }
    }
  });
}

app.post('/webhook/facebook', (req, res) => {
  if (ENV.facebookAppSecret
    && !facebook.verifySignature(req.rawBody, req.get('X-Hub-Signature-256'))) {
    console.warn('[facebook] Rejected webhook with missing or invalid signature.');
    return res.sendStatus(401);
  }

  // Acknowledge at once: Meta retries after ~20 s, but AI and Rocket.Chat can be
  // slower than that. The real work continues in the per-customer queue.
  res.sendStatus(200);

  facebook.handleWebhook(
    req.body,
    (psid, text, meta) => enqueueFacebookTask(psid, meta && meta.key, () =>
      forwardToRocketChat(CHANNELS.facebook, psid, `FB ${psid}`, text)),
    (psid, attachment, meta) => enqueueFacebookTask(psid, meta && meta.key, () =>
      handleFacebookAttachment(psid, attachment))
  ).catch((err) => console.error('[facebook] Error handling webhook:', err.message));
});

// ============================================================
// Telegram webhook route
// ============================================================

app.post('/webhook/telegram', async (req, res) => {
  const rejection = telegramWebhookRejection({
    pollingEnabled: TELEGRAM_POLLING_ENABLED,
    secret: ENV.telegramWebhookSecret,
    header: req.get('X-Telegram-Bot-Api-Secret-Token'),
  });
  if (rejection) return res.sendStatus(rejection);
  try {
    await telegram.handleWebhook(req.body, async (chatId, text, meta) => {
      await forwardToRocketChat('telegram', chatId, `TG ${chatId}`, text, meta);
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
  const m = metrics.snapshot();
  res.json({
    status: 'ok',
    activeRooms: mapping.getActiveEntries().length,
    facebookQueueDepth: facebookQueue.size(),
    lastAgentPollAt: m.lastAgentPollAt || null,
    lastTelegramPollAt: m.lastTelegramPollAt || null,
    rocketChat429: m.rateLimited429,
    customerRateLimited: rateLimiter.limitedTotal(),
    facebookTokenConfigured: Boolean(ENV.facebookPageAccessToken),
    uptimeSeconds: Math.round((Date.now() - m.startedAt) / 1000),
  });
});

// ============================================================
// Document upload routes (MVP local RAG)
// ============================================================

app.post('/documents/upload', (req, res) => {
  const authResult = authorizeAdmin(req);
  if (authResult) return res.status(authResult.status).json({ success: false, error: authResult.message });
  try {
    const result = documents.uploadDocument(req.body || {});
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[documents] Upload failed:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/documents', (req, res) => {
  const authResult = authorizeAdmin(req);
  if (authResult) return res.status(authResult.status).json({ success: false, error: authResult.message });
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
  metrics.set('lastTelegramPollAt', Date.now());
  try {
    await telegram.pollUpdates(async (chatId, text, meta) => {
      await forwardToRocketChat('telegram', chatId, `TG ${chatId}`, text, meta);
    }, handleTelegramDocument, handleUnsupportedTelegramMessage, handleTelegramMedia);
  } catch (err) {
    console.error('[telegram] Error polling updates:', err.message);
  } finally {
    telegramPollingInProgress = false;
  }
}

async function pollAgentMessages() {
  if (agentPollingInProgress) return;
  if (Date.now() < rocketChatPollingNotBefore) return;
  agentPollingInProgress = true;
  metrics.set('lastAgentPollAt', Date.now());

  try {
  const activeEntries = mapping.getActiveEntries().filter((entry) => entry.roomId && entry.visitorToken);
  if (activeEntries.length === 0) return;

  // Rocket.Chat rate-limits messages.history, so spend a fixed call budget per
  // tick on the rooms that most need a poll instead of polling all of them.
  const entries = pollScheduler.select(
    activeEntries,
    callsPerTick(ENV.rocketChatPollMaxCallsPerMinute, POLL_INTERVAL_MS)
  );

  for (const entry of entries) {
    try {
      pollScheduler.markPolled(entry);
      const newMessages = await rocketchat.pollNewAgentMessages(
        entry.roomId,
        entry.visitorToken,
        entry.lastMessageTimestamp,
        entry.processedMessageIds || []
      );

      // A human answered: keep the AI quiet in this room for a while.
      if (newMessages.some((m) => (m.msg && m.msg !== 'connected') || rocketchat.extractAttachments(m).length > 0)) {
        mapping.update(entry, { agentActiveAt: Date.now() });
      }

      let deliveryPending = false; // a message is waiting for a retry
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

        if ((entry.platform === 'telegram' || entry.platform === 'facebook')
          && attachments.length > 0 && text !== 'connected') {
          let attachmentFailed = false;
          for (const attachment of pendingAttachments) {
            const attachmentRetryKey = `${retryKey}:${attachment.source}`;
            try {
              const downloaded = await downloadRocketChatFile(attachment.source);
              await sendAttachmentToPlatform(entry.platform, entry.platformUserId, {
                ...attachment,
                buffer: downloaded.buffer,
                mimeType: downloaded.mimeType || attachment.mimeType,
                filename: downloaded.filename || attachment.filename,
                size: downloaded.buffer.length,
              }, completed.size === 0 ? text : '');
              completed.add(attachment.source);
              messageRetryCounts.delete(attachmentRetryKey);
            } catch (err) {
              console.error(`[poll] Failed to forward attachment ${attachment.filename} to ${entry.platform}:`, err.message);
              const failure = classifyDeliveryError(entry.platform, err);
              if (failure.kind === 'auth') console.error(`[ALERT] ${entry.platform} credentials rejected: ${failure.reason}`);
              const downloadFailed = isPermanentDownloadError(err);
              const permanent = downloadFailed || failure.kind === 'permanent';
              const retries = (messageRetryCounts.get(attachmentRetryKey) || 0) + 1;
              if (permanent || retries >= ENV.rocketChatMaxMessageRetries) {
                completed.add(attachment.source);
                messageRetryCounts.delete(attachmentRetryKey);
                await notifyDeliveryFailure(
                  entry,
                  `file "${attachment.filename}"`,
                  downloadFailed ? 'không tải được file từ Rocket.Chat' : failure.reason
                );
              } else {
                messageRetryCounts.set(attachmentRetryKey, retries);
                attachmentFailed = true;
              }
              try {
                await sendReplyToPlatform(entry.platform, entry.platformUserId, mediaDeliveryFailedMessage(entry.platform));
              } catch (noticeErr) {
                console.error('[poll] Failed to send attachment error notice:', noticeErr.message);
              }
              if (attachmentFailed) break;
            }
          }
          if (attachmentFailed) {
            completedAttachmentKeys.set(retryKey, completed);
            deliveryPending = true;
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
          `[poll] New agent message in room ${entry.roomId} -> ${entry.platform}:${entry.platformUserId}`
        );

        try {
          if (entry.platform === 'facebook') {
            // Messenger has no formatting or date entity: plain text, split at 2000.
            await facebook.sendAgentMessage(entry.platformUserId, text, { timeZone: ENV.timezone });
          } else if (entry.platform === 'telegram') {
            // Agent text only: render Rocket.Chat Markdown (bold/italic/strike/code).
            await telegram.sendMessage(entry.platformUserId, text, { markdown: true });
          }
          messageRetryCounts.delete(retryKey);
          markMessageProcessed(entry, messageId, ts);
        } catch (err) {
          console.error(`[poll] Failed to forward message ${msg._id} to ${entry.platform}:`, err.message);
          const failure = classifyDeliveryError(entry.platform, err);
          if (failure.kind === 'auth') console.error(`[ALERT] ${entry.platform} credentials rejected: ${failure.reason}`);
          const retries = (messageRetryCounts.get(retryKey) || 0) + 1;
          messageRetryCounts.set(retryKey, retries);
          // Retrying cannot fix a blocked customer or a closed 24 h window.
          if (failure.kind === 'permanent' || retries >= ENV.rocketChatMaxMessageRetries) {
            console.error(`[poll] Giving up on message ${msg._id} (${failure.kind}) after ${retries} attempt(s).`);
            messageRetryCounts.delete(retryKey);
            markMessageProcessed(entry, messageId, ts);
            await notifyDeliveryFailure(entry, 'tin nhắn', failure.reason);
          } else {
            deliveryPending = true;
            break;
          }
        }
      }

      // The agent closed the conversation and everything was delivered: stop
      // polling this room; the customer's next message opens a fresh one.
      if (newMessages.closed && !deliveryPending) {
        mapping.update(entry, { roomId: null, ...rocketchat.roomStateReset() });
        console.log(`[poll] Conversation closed by the agent for ${entry.platform}:${entry.platformUserId}.`);
      }
    } catch (err) {
      console.error(`[poll] Error polling room ${entry.roomId}:`, err.message);
      if (err.status === 429) {
        // The room was refused, not served: keep it first in line for next time.
        pollScheduler.release(entry);
        const retryAfterSeconds = Number(
          String(err.body && err.body.error || err.message).match(/wait\s+(\d+)\s+seconds?/i)?.[1]
        );
        const cooldownMs = (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds
          : 10) * 1000;
        rocketChatPollingNotBefore = Date.now() + cooldownMs;
        console.warn(`[poll] Rocket.Chat rate limit reached; pausing polling for ${Math.ceil(cooldownMs / 1000)}s.`);
        break;
      }
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

if (require.main === module) start();

function authorizeAdmin(req) {
  if (!ENV.adminApiKey) {
    return { status: 503, message: 'ADMIN_API_KEY is not configured; document endpoints are disabled.' };
  }
  const authorization = String(req.get('Authorization') || '');
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const expected = Buffer.from(ENV.adminApiKey);
  const received = Buffer.from(supplied);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return { status: 401, message: 'Authorization Bearer token is required.' };
  }
  return null;
}

module.exports = { app, authorizeAdmin, facebookQueue, forwardToRocketChat, isAiPaused, start };
