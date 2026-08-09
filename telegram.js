/**
 * telegram.js
 * -----------
 * Telegram Bot integration:
 *  - POST /webhook/telegram : receive incoming messages
 *  - sendMessage()          : send a message back via Bot API
 */

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

/**
 * Handle POST webhook payload from Telegram Bot API.
 * Parses chat_id and message text, then calls the provided callback.
 *
 * @param {object} body - parsed JSON body
 * @param {function} onMessage - async (chatId, text) => void
 */
async function handleWebhook(body, onMessage) {
  const message = body.message || body.edited_message;

  if (!message) {
    console.log('[telegram] Received non-message update, ignoring.');
    return;
  }

  const chatId = message.chat && message.chat.id;
  const text = message.text;

  if (!chatId) {
    console.warn('[telegram] Update without chat id, skipping.');
    return;
  }

  if (text) {
    console.log(`[telegram] Received message from chat ${chatId}: "${text}"`);
    await onMessage(chatId, text);
  } else {
    console.log(`[telegram] Received non-text message from chat ${chatId}, ignoring.`);
  }
}

/**
 * Send a text message to a Telegram chat via Bot API.
 * POST https://api.telegram.org/bot<TOKEN>/sendMessage
 */
async function sendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
  };

  console.log(`[telegram] Sending message to chat ${chatId}: "${text}"`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram send failed (${res.status}): ${JSON.stringify(data)}`);
  }

  console.log(`[telegram] Message sent to chat ${chatId}.`);
  return data;
}

module.exports = {
  handleWebhook,
  sendMessage,
};
