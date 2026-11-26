/**
 * Incoming Zalo attachments -> Rocket.Chat.
 */

const rocketchat = require('../rocketchat/rocketchat');
const zalo = require('../platforms/zalo');
const { CHANNELS, ENV } = require('../constants/config');
const { MESSAGES } = require('../constants/messages');
const { downloadZaloMedia, isZaloFileTooLarge } = require('../media/zaloFiles');
const { ensureRocketChatRoom } = require('./rocketchatRoom');
const { relayMediaToRocketChat } = require('./mediaPipeline');

const DOWNLOADABLE = new Set(['image', 'video', 'audio', 'file']);

/** A line for the agent about content that is not a file to upload. */
function describe(type, payload) {
  const coords = payload.coordinates;
  const lat = coords && Number(coords.latitude);
  const long = coords && Number(coords.longitude);
  if (type === 'location' && Number.isFinite(lat) && Number.isFinite(long)) {
    return MESSAGES.zalo.locationRoomMessage(`https://www.google.com/maps?q=${lat},${long}`);
  }
  if (type === 'link' && payload.url) return MESSAGES.zalo.linkRoomMessage(payload.url);
  return MESSAGES.zalo.unsupportedRoomMessage(type);
}

async function handleZaloAttachment(userId, attachment) {
  const { type, payload } = attachment;
  const roomName = `Zalo ${userId}`;

  if (!DOWNLOADABLE.has(type) || !payload.url) {
    try {
      const { visitorToken, roomId } = await ensureRocketChatRoom(CHANNELS.zalo, userId, roomName);
      await rocketchat.sendMessageToRocketChat(visitorToken, roomId, describe(type, payload));
    } catch (err) {
      console.error(`[zalo] Failed to log ${type} from ${userId}:`, err.message);
    }
    return;
  }

  const fallbackName = `${type}_${Date.now()}`;
  await relayMediaToRocketChat({
    platform: CHANNELS.zalo,
    userId,
    roomName,
    type,
    origin: `from ${userId}`,
    filename: payload.name || fallbackName,
    download: () => downloadZaloMedia(payload.url, {
      maxBytes: ENV.zaloMaxMediaBytes,
      filename: payload.name,
      fallbackName,
    }),
    isTooLarge: isZaloFileTooLarge,
    sendNotice: (text) => zalo.sendMessage(userId, text),
    notices: { tooLarge: MESSAGES.zalo.mediaTooLarge, failed: MESSAGES.zalo.mediaUploadFailed },
    statusMessage: (filename, reason) => MESSAGES.zalo.mediaUploadStatus(type, filename, reason),
  });
}

module.exports = { handleZaloAttachment };
