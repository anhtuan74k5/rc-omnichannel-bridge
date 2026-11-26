/**
 * Incoming Telegram documents and media -> Rocket.Chat.
 */

const rocketchat = require('../rocketchat/rocketchat');
const telegram = require('../platforms/telegram');
const documents = require('../knowledge/documents');
const ai = require('../knowledge/ai');
const { CHANNELS, ENV, FILES, MIME_TYPES } = require('../constants/config');
const { MESSAGES } = require('../constants/messages');
const { downloadTelegramFile, isTelegramFileTooLarge } = require('../media/telegramFiles');
const { ensureRocketChatRoom } = require('./rocketchatRoom');
const { forwardToRocketChat } = require('./forwardToRocketChat');
const { relayMediaToRocketChat } = require('./mediaPipeline');

/** Lets the AI answer questions about a readable document. Never blocks delivery. */
async function indexDocumentForAi(chatId, file) {
  if (!ai.isEnabled()) return;
  let result;
  try {
    result = await documents.uploadDocumentBuffer({
      platform: CHANNELS.telegram,
      platformUserId: chatId,
      filename: file.filename,
      buffer: file.buffer,
    });
  } catch (err) {
    console.warn(`[documents] File from chat ${chatId} was delivered but not indexed: ${err.message}`);
    return;
  }
  try {
    await telegram.sendMessage(chatId, MESSAGES.telegram.documentUploaded(result.filename, result.document.chunks));
  } catch (err) {
    console.error(`[telegram] Failed to confirm the document to chat ${chatId}:`, err.message);
  }
}

/** A file of any type goes to the agent; indexing it for the AI is extra. */
async function handleTelegramDocument(chatId, document, caption) {
  const filename = document.file_name || FILES.defaultDocument;
  let file = null;
  await relayMediaToRocketChat({
    platform: CHANNELS.telegram,
    userId: chatId,
    roomName: `TG ${chatId}`,
    type: 'document',
    origin: `from chat ${chatId}`,
    filename,
    download: async () => {
      const downloaded = await downloadTelegramFile(document.file_id, {
        maxBytes: ENV.telegramMaxDocumentBytes,
      });
      file = { buffer: downloaded.buffer, filename, mimeType: document.mime_type || MIME_TYPES.octetStream };
      return file;
    },
    isTooLarge: isTelegramFileTooLarge,
    sendNotice: (text) => telegram.sendMessage(chatId, text),
    notices: { tooLarge: MESSAGES.telegram.mediaTooLarge, failed: MESSAGES.telegram.mediaUploadFailed },
    statusMessage: (name, reason) => MESSAGES.telegram.mediaUploadStatus('document', name, reason),
    afterUpload: async () => {
      await indexDocumentForAi(chatId, file);
      if (caption && caption.trim()) {
        await forwardToRocketChat(CHANNELS.telegram, chatId, `TG ${chatId}`, caption.trim());
      }
    },
  });
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

  await relayMediaToRocketChat({
    platform: CHANNELS.telegram,
    userId: chatId,
    roomName: `TG ${chatId}`,
    type: messageType,
    origin: `from chat ${chatId}`,
    filename: descriptor.filename,
    download: async () => {
      const downloaded = await downloadTelegramFile(descriptor.fileId, {
        maxBytes: ENV.telegramMaxMediaBytes,
      });
      return { buffer: downloaded.buffer, filename: descriptor.filename, mimeType: descriptor.mimeType };
    },
    isTooLarge: isTelegramFileTooLarge,
    sendNotice: (text) => telegram.sendMessage(chatId, text),
    notices: { tooLarge: MESSAGES.telegram.mediaTooLarge, failed: MESSAGES.telegram.mediaUploadFailed },
    statusMessage: (filename, reason) => MESSAGES.telegram.mediaUploadStatus(messageType, filename, reason),
    afterUpload: async () => {
      if (caption && caption.trim()) {
        await forwardToRocketChat(CHANNELS.telegram, chatId, `TG ${chatId}`, caption.trim());
      }
    },
    rethrow: true,
  });
}

module.exports = { handleTelegramDocument, handleUnsupportedTelegramMessage, handleTelegramMedia };
