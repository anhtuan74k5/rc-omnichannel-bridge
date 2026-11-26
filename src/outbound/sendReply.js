const facebook = require('../platforms/facebook');
const telegram = require('../platforms/telegram');
const zalo = require('../platforms/zalo');

/**
 * Send a reply back to the correct platform (Facebook, Telegram or Zalo).
 */
async function sendReplyToPlatform(platform, platformUserId, text) {
  if (platform === 'facebook') {
    await facebook.sendMessage(platformUserId, text);
  } else if (platform === 'telegram') {
    await telegram.sendMessage(platformUserId, text);
  } else if (platform === 'zalo') {
    await zalo.sendMessage(platformUserId, text);
  }
}

module.exports = { sendReplyToPlatform };
