const rocketchat = require('../rocketchat/rocketchat');
const { MESSAGES } = require('../constants/messages');
const metrics = require('../core/metrics');

/** Loud, repeatable signal that a platform token was refused: log line plus /health. */
function alertCredentialsRejected(platform, reason) {
  console.error(`[ALERT] ${platform} credentials rejected: ${reason}`);
  metrics.set(`${platform}AuthRejectedAt`, Date.now());
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

module.exports = { alertCredentialsRejected, notifyDeliveryFailure };
