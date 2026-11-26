/**
 * Shared pipeline for customer media: download from the platform, upload into
 * the Rocket.Chat room, and on failure tell the customer and the agent.
 * Used by the Telegram and Facebook inbound handlers.
 */

const rocketchat = require('../rocketchat/rocketchat');
const { ensureRocketChatRoom } = require('./rocketchatRoom');

/**
 * @param {object} o
 * @param {string} o.platform       'telegram' | 'facebook' (log prefix and room key)
 * @param {string|number} o.userId  platform user id
 * @param {string} o.roomName       visitor display name for a new room
 * @param {string} o.type           media type, for logs and the agent status line
 * @param {string} o.origin         log fragment, e.g. `from chat 123`
 * @param {string} o.filename       name used until the download supplies one
 * @param {() => Promise<{buffer: Buffer, filename?: string, mimeType?: string}>} o.download
 * @param {(err: Error) => boolean} o.isTooLarge
 * @param {(text: string) => Promise<unknown>} o.sendNotice  message to the customer
 * @param {{tooLarge: string, failed: string}} o.notices     customer-facing texts
 * @param {(filename: string, reason: string) => string} o.statusMessage  agent-facing line
 * @param {() => Promise<unknown>} [o.afterUpload]  runs inside the guarded block
 * @param {boolean} [o.rethrow]     rethrow non-"too large" errors after reporting
 */
async function relayMediaToRocketChat(o) {
  let filename = o.filename;
  try {
    const downloaded = await o.download();
    filename = downloaded.filename || filename;
    const { visitorToken, roomId } = await ensureRocketChatRoom(o.platform, o.userId, o.roomName);
    await rocketchat.uploadLivechatFile(visitorToken, roomId, {
      filename,
      buffer: downloaded.buffer,
      mimeType: downloaded.mimeType,
    });
    if (o.afterUpload) await o.afterUpload();
  } catch (err) {
    console.error(`[${o.platform}] Failed to handle ${o.type} ${o.origin}:`, err.message);
    const tooLarge = o.isTooLarge(err);
    try {
      await o.sendNotice(tooLarge ? o.notices.tooLarge : o.notices.failed);
    } catch (sendErr) {
      console.error(`[${o.platform}] Failed to send ${o.type} error notice:`, sendErr.message);
    }
    try {
      const { visitorToken, roomId } = await ensureRocketChatRoom(o.platform, o.userId, o.roomName);
      await rocketchat.sendMessageToRocketChat(visitorToken, roomId, o.statusMessage(filename, err.message));
    } catch (roomErr) {
      console.error(`[rocketchat] Failed to log ${o.type} upload error:`, roomErr.message);
    }
    if (o.rethrow && !tooLarge) throw err;
  }
}

module.exports = { relayMediaToRocketChat };
