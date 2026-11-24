const telegram = require('../platforms/telegram');
const metrics = require('../core/metrics');
const { forwardToRocketChat } = require('./forwardToRocketChat');
const { handleTelegramDocument, handleUnsupportedTelegramMessage, handleTelegramMedia } = require('./telegram');

let telegramPollingInProgress = false;

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

module.exports = { pollTelegramUpdates };
