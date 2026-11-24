const facebook = require('../../facebook');
const telegram = require('../../telegram');

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

module.exports = { sendReplyToPlatform };
