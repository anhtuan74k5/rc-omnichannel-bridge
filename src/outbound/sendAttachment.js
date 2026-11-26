const facebook = require('../platforms/facebook');
const telegram = require('../platforms/telegram');
const zalo = require('../platforms/zalo');
const { ENV } = require('../constants/config');
const { MESSAGES } = require('../constants/messages');

/**
 * Send one Rocket.Chat attachment to the customer's platform. Telegram carries
 * the caption natively; Messenger and Zalo get no caption here, so the text follows as a
 * separate message (its failure is logged, not retried, to avoid re-sending
 * the file).
 */
async function sendAttachmentToPlatform(platform, platformUserId, descriptor, caption) {
  if (platform === 'telegram') {
    await telegram.sendMedia(platformUserId, descriptor, caption, { markdown: true });
    return;
  }
  const adapter = platform === 'zalo' ? zalo : facebook;
  await adapter.sendMedia(platformUserId, descriptor);
  if (caption && caption.trim()) {
    try {
      await adapter.sendAgentMessage(platformUserId, caption, { timeZone: ENV.timezone });
    } catch (err) {
      console.error(`[${platform}] Failed to send attachment caption:`, err.message);
    }
  }
}

// Messenger refuses archive files (seen live with .zip); retrying never helps.
const MESSENGER_REFUSED_EXTENSIONS = /\.(zip|rar|7z)$/i;

function mediaDeliveryFailedMessage(platform, filename = '') {
  if (platform === 'facebook' && MESSENGER_REFUSED_EXTENSIONS.test(String(filename))) {
    return MESSAGES.bridge.unsupportedFileType(platform);
  }
  if (platform === 'zalo' && !/\.(jpe?g|png|gif|pdf|docx?)$/i.test(String(filename))) {
    return MESSAGES.bridge.unsupportedFileType(platform);
  }
  return (MESSAGES[platform] || MESSAGES.telegram).mediaDeliveryFailed;
}

module.exports = { sendAttachmentToPlatform, mediaDeliveryFailedMessage };
