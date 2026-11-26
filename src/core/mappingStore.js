/**
 * Where the mapping entries are kept on disk.
 *
 *  - json   (default): one file, rewritten atomically on every change.
 *  - sqlite (MAPPING_STORE=sqlite): one row per customer, using Node's built-in
 *    node:sqlite (Node 22.13+). On first start an existing JSON file is imported;
 *    the file itself is left untouched.
 *
 * Both expose { name, location, load() -> entries, save(entries, changed) }.
 */

const fs = require('fs');
const path = require('path');

/** Keep an unreadable file: the next save would otherwise overwrite it for good. */
function keepCorruptCopy(file) {
  try {
    const backup = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, backup);
    console.error(`[mapping] ALERT: the unreadable mapping file was kept as ${path.basename(backup)}; restore it by hand if needed.`);
  } catch (err) {
    console.error('[mapping] Could not keep a copy of the unreadable mapping file:', err.message);
  }
}

/** Entries in the JSON file, or null when there is no readable file. */
function readJsonEntries(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch (err) {
    console.error('[mapping] Failed to load mapping file, starting fresh:', err.message);
    keepCorruptCopy(file);
    return null;
  }
}

function createJsonStore(file) {
  function save(entries) {
    const tempFile = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tempFile, JSON.stringify({ entries }, null, 2), 'utf8');
      fs.renameSync(tempFile, file);
    } catch (err) {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch (cleanupErr) {
        console.error('[mapping] Failed to clean up temporary mapping file:', cleanupErr.message);
      }
      console.error('[mapping] Failed to save mapping file:', err.message);
      throw err;
    }
  }

  function load() {
    const entries = readJsonEntries(file);
    if (entries) return entries;
    save([]);
    return [];
  }

  return { name: 'json', location: file, load, save };
}

function createSqliteStore(file, importFrom) {
  // Required only when chosen, so older Node versions can still use the JSON store.
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS entries (
      platform         TEXT NOT NULL,
      platform_user_id TEXT NOT NULL,
      data             TEXT NOT NULL,
      PRIMARY KEY (platform, platform_user_id)
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const upsert = db.prepare(`
    INSERT INTO entries (platform, platform_user_id, data) VALUES (?, ?, ?)
    ON CONFLICT (platform, platform_user_id) DO UPDATE SET data = excluded.data
  `);
  const write = (entry) => upsert.run(entry.platform, String(entry.platformUserId), JSON.stringify(entry));

  function inTransaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      work();
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function importJsonOnce() {
    if (db.prepare("SELECT 1 FROM meta WHERE key = 'json_imported'").get()) return;
    const entries = (importFrom && readJsonEntries(importFrom)) || [];
    inTransaction(() => {
      for (const entry of entries) write(entry);
      db.prepare("INSERT INTO meta (key, value) VALUES ('json_imported', ?)").run(new Date().toISOString());
    });
    if (entries.length > 0) {
      console.log(`[mapping] Imported ${entries.length} entries from ${importFrom} into SQLite.`);
    }
  }

  function load() {
    importJsonOnce();
    return db.prepare('SELECT data FROM entries ORDER BY rowid').all().map((row) => JSON.parse(row.data));
  }

  /** `changed` writes that one customer; without it every entry is written. */
  function save(entries, changed) {
    try {
      if (changed) write(changed);
      else inTransaction(() => entries.forEach(write));
    } catch (err) {
      console.error('[mapping] Failed to save mapping database:', err.message);
      throw err;
    }
  }

  return { name: 'sqlite', location: file, load, save, close: () => db.close() };
}

module.exports = { createJsonStore, createSqliteStore };
