/**
 * customerNames.js
 * ----------------
 * Display name for a new Rocket.Chat visitor. Telegram: from the update's
 * `from`/`chat`. Facebook: User Profile API. The result is cached on the
 * mapping entry (`displayName`); on failure the caller's fallback is used and
 * nothing is cached, so a later message can try again.
 */

const mapping = require('./mapping');
const { fetchProfileName } = require('../platforms/facebookProfile');

const telegramNames = new Map();
const MAX_TELEGRAM_NAMES = 1000;

function telegramDisplayName(from, chat) {
  const person = from || chat || {};
  const full = [person.first_name, person.last_name].filter(Boolean).join(' ').trim();
  if (full) return full;
  if (person.username) return `@${person.username}`;
  return (chat && chat.title) || '';
}

/** Called by telegram.js for every incoming update. */
function rememberTelegramName(chatId, message) {
  const name = telegramDisplayName(message && message.from, message && message.chat);
  if (!name) return;
  if (telegramNames.size >= MAX_TELEGRAM_NAMES) telegramNames.delete(telegramNames.keys().next().value);
  telegramNames.set(String(chatId), name);
}

async function resolveCustomerName(platform, platformUserId, fallback, deps = {}) {
  const entry = mapping.findByPlatformUser(platform, platformUserId);
  if (entry && entry.displayName) return entry.displayName;

  let name = null;
  if (platform === 'telegram') name = telegramNames.get(String(platformUserId)) || null;
  else if (platform === 'facebook') name = await (deps.fetchProfileName || fetchProfileName)(platformUserId);

  if (!name) return fallback;
  const target = entry || mapping.getOrCreate(platform, platformUserId);
  mapping.update(target, { displayName: name });
  return name;
}

module.exports = { rememberTelegramName, resolveCustomerName, telegramDisplayName };
