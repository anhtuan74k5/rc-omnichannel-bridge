const express = require('express');
const telegram = require('../../telegram');
const { ENV } = require('../../constants/config');
const { telegramWebhookRejection } = require('../../webhookGuards');
const { forwardToRocketChat } = require('../inbound/forwardToRocketChat');
const { handleTelegramDocument, handleUnsupportedTelegramMessage, handleTelegramMedia } = require('../inbound/telegram');

const router = express.Router();
const TELEGRAM_POLLING_ENABLED = ENV.telegramPollingEnabled;

router.post('/webhook/telegram', async (req, res) => {
  const rejection = telegramWebhookRejection({
    pollingEnabled: TELEGRAM_POLLING_ENABLED,
    secret: ENV.telegramWebhookSecret,
    header: req.get('X-Telegram-Bot-Api-Secret-Token'),
  });
  if (rejection) return res.sendStatus(rejection);
  try {
    await telegram.handleWebhook(req.body, async (chatId, text, meta) => {
      await forwardToRocketChat('telegram', chatId, `TG ${chatId}`, text, meta);
    }, handleTelegramDocument, handleUnsupportedTelegramMessage, handleTelegramMedia);
    res.sendStatus(200);
  } catch (err) {
    console.error('[telegram] Error handling webhook:', err.message);
    res.sendStatus(500);
  }
});

module.exports = router;
