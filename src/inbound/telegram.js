/**
 * Incoming Telegram documents and media -> Rocket.Chat.
 */

const rocketchat = require('../../rocketchat');
const telegram = require('../../telegram');
const documents = require('../../knowledge/documents');
const { CHANNELS, ENV } = require('../../constants/config');
const { MESSAGES } = require('../../constants/messages');
const { downloadTelegramFile, isTelegramFileTooLarge } = require('../../media/telegramFiles');
const { ensureRocketChatRoom } = require('./rocketchatRoom');
const { forwardToRocketChat } = require('./forwardToRocketChat');
const { relayMediaToRocketChat } = require('./mediaPipeline');

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
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
