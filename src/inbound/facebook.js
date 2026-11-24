/**
 * Incoming Facebook attachments -> Rocket.Chat, and the per-customer task queue.
 */

const mapping = require('../../mapping');
const rocketchat = require('../../rocketchat');
const facebook = require('../../facebook');
const { CHANNELS, ENV } = require('../../constants/config');
const { MESSAGES } = require('../../constants/messages');
const { downloadFacebookAttachment, isFacebookFileTooLarge } = require('../../media/facebookFiles');
const { facebookQueue, facebookInFlight } = require('../runtime');
const { ensureRocketChatRoom } = require('./rocketchatRoom');
const { relayMediaToRocketChat } = require('./mediaPipeline');

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

  const fallbackName = `${type}_${Date.now()}`;
  await relayMediaToRocketChat({
    platform: CHANNELS.facebook,
    userId: psid,
    roomName: name,
    type,
    origin: `from ${psid}`,
    filename: fallbackName,
    download: () => downloadFacebookAttachment(url, {
      maxBytes: ENV.facebookMaxMediaBytes,
      fallbackName,
    }),
    isTooLarge: isFacebookFileTooLarge,
    sendNotice: (text) => facebook.sendMessage(psid, text),
    notices: { tooLarge: MESSAGES.facebook.mediaTooLarge, failed: MESSAGES.facebook.mediaUploadFailed },
    statusMessage: (filename, reason) => MESSAGES.facebook.mediaUploadStatus(type, filename, reason),
  });
}

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

module.exports = { handleFacebookAttachment, enqueueFacebookTask };
