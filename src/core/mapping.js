/**
 * mapping.js
 * ----------
 * Maps a platform user (Facebook PSID, Telegram chat_id, ...) to a Rocket.Chat
 * visitor token and room. Entries are held in memory and persisted by a store
 * (core/mappingStore.js): a JSON file by default, or SQLite.
 *
 * An entry:
 *   { "platform": "telegram", "platformUserId": "<id>", "visitorToken": "<token>",
 *     "roomId": "<room id>", "lastMessageTimestamp": 0, "active": true }
 */

const path = require('path');
const { createJsonStore, createSqliteStore } = require('./mappingStore');

// MAPPING_FILE lets tests (or a second deployment) use a different store.
const MAPPING_FILE = process.env.MAPPING_FILE || path.join(__dirname, '..', '..', 'mapping.json');
const MAX_INBOUND_IDS = 100;

let entries = [];
let store = null;

function openStore() {
  const kind = String(process.env.MAPPING_STORE || 'json').trim().toLowerCase();
  if (kind === 'json') return createJsonStore(MAPPING_FILE);
  if (kind === 'sqlite') {
    const database = process.env.MAPPING_DB || `${MAPPING_FILE.replace(/\.json$/i, '')}.db`;
    return createSqliteStore(database, MAPPING_FILE);
  }
  // A typo must not silently start an empty store next to the real one.
  throw new Error(`MAPPING_STORE must be "json" or "sqlite", not "${kind}"`);
}

function activeStore() {
  if (!store) store = openStore();
  return store;
}

function load() {
  entries = activeStore().load();
  entries.forEach((entry) => {
    if (!Array.isArray(entry.processedMessageIds)) entry.processedMessageIds = [];
    if (!Array.isArray(entry.processedInboundIds)) entry.processedInboundIds = [];
  });
  console.log(`[mapping] Loaded ${entries.length} mapping entries from ${activeStore().location}`);
}

/** Persist `changed`, or everything when called without it. */
function save(changed) {
  activeStore().save(entries, changed);
}

/**
 * Find an entry by platform + platformUserId.
 */
function findByPlatformUser(platform, platformUserId) {
  return entries.find(
    (e) => e.platform === platform && e.platformUserId === String(platformUserId)
  );
}

/**
 * Find an entry by visitor token.
 */
function findByVisitorToken(visitorToken) {
  return entries.find((e) => e.visitorToken === visitorToken);
}

/**
 * Find an entry by room id.
 */
function findByRoomId(roomId) {
  return entries.find((e) => e.roomId === roomId);
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
    processedMessageIds: [],
    processedInboundIds: [],
    active: true,
  };
  entries.push(entry);
  save(entry);
  console.log(`[mapping] Created new mapping entry for ${platform}:${platformUserId}`);
  return entry;
}

/**
 * Update fields of an entry and persist.
 */
function update(entry, fields) {
  Object.assign(entry, fields);
  save(entry);
}

/**
 * Inbound de-duplication: platforms may redeliver the same message (Meta
 * retries webhooks). Remembers the last MAX_INBOUND_IDS platform message keys.
 */
function hasProcessedInbound(entry, key) {
  return Array.isArray(entry.processedInboundIds) && entry.processedInboundIds.includes(key);
}

function markInboundProcessed(entry, key) {
  const ids = Array.isArray(entry.processedInboundIds) ? entry.processedInboundIds : [];
  if (!ids.includes(key)) ids.push(key);
  update(entry, { processedInboundIds: ids.slice(-MAX_INBOUND_IDS) });
}

/**
 * Return all active entries (used by the polling loop).
 */
function getActiveEntries() {
  return entries.filter((e) => e.active && e.roomId && e.visitorToken);
}

module.exports = {
  load,
  save,
  findByPlatformUser,
  findByVisitorToken,
  findByRoomId,
  getOrCreate,
  update,
  hasProcessedInbound,
  markInboundProcessed,
  getActiveEntries,
};
