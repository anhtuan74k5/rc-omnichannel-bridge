/**
 * mapping.js
 * ----------
 * Simple JSON-file-backed store that persists the mapping between a platform
 * user (Facebook PSID or Telegram chat_id) and a Rocket.Chat visitor token /
 * room id / platform. Data survives server restarts.
 *
 * mapping.json structure:
 * {
 *   "entries": [
 *     {
 *       "platform": "facebook" | "telegram",
 *       "platformUserId": "<PSID or chat_id>",
 *       "visitorToken": "<rocketchat visitor token>",
 *       "roomId": "<rocketchat room id>",
 *       "lastMessageTimestamp": 0,
 *       "active": true
 *     }
 *   ]
 * }
 */

const fs = require('fs');
const path = require('path');

const MAPPING_FILE = path.join(__dirname, 'mapping.json');

let store = { entries: [] };

function load() {
  try {
    if (fs.existsSync(MAPPING_FILE)) {
      const raw = fs.readFileSync(MAPPING_FILE, 'utf8');
      store = JSON.parse(raw);
      if (!Array.isArray(store.entries)) store.entries = [];
      console.log(`[mapping] Loaded ${store.entries.length} mapping entries from ${MAPPING_FILE}`);
    } else {
      store = { entries: [] };
      save();
    }
  } catch (err) {
    console.error('[mapping] Failed to load mapping file, starting fresh:', err.message);
    store = { entries: [] };
  }
}

function save() {
  try {
    fs.writeFileSync(MAPPING_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    console.error('[mapping] Failed to save mapping file:', err.message);
  }
}

/**
 * Find an entry by platform + platformUserId.
 */
function findByPlatformUser(platform, platformUserId) {
  return store.entries.find(
    (e) => e.platform === platform && e.platformUserId === String(platformUserId)
  );
}

/**
 * Find an entry by visitor token.
 */
function findByVisitorToken(visitorToken) {
  return store.entries.find((e) => e.visitorToken === visitorToken);
}

/**
 * Find an entry by room id.
 */
function findByRoomId(roomId) {
  return store.entries.find((e) => e.roomId === roomId);
}

/**
 * Create a new mapping entry (or return existing one).
 */
function getOrCreate(platform, platformUserId) {
  const existing = findByPlatformUser(platform, platformUserId);
  if (existing) return existing;

  const entry = {
    platform,
    platformUserId: String(platformUserId),
    visitorToken: null,
    roomId: null,
    lastMessageTimestamp: 0,
    active: true,
  };
  store.entries.push(entry);
  save();
  console.log(`[mapping] Created new mapping entry for ${platform}:${platformUserId}`);
  return entry;
}

/**
 * Update fields of an entry and persist.
 */
function update(entry, fields) {
  Object.assign(entry, fields);
  save();
}

/**
 * Return all active entries (used by the polling loop).
 */
function getActiveEntries() {
  return store.entries.filter((e) => e.active && e.roomId && e.visitorToken);
}

module.exports = {
  load,
  save,
  findByPlatformUser,
  findByVisitorToken,
  findByRoomId,
  getOrCreate,
  update,
  getActiveEntries,
};
