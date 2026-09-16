const { DatabaseSync } = require('node:sqlite');

let db;
// Cached rows come back in the order their view's query returns them, so a boot from the cache and a refresh agree:
// meetings by start time ascending, everything else newest first (sortKey is the update time there).
const DESC = new Set(['inbox', 'tasks', 'library', 'chats']);

function open(path) {
  db = new DatabaseSync(path);
  db.exec('DROP TABLE IF EXISTS tasks'); // pre-sections schema; the cache is rebuilt on the next refresh
  // One row per (view, document): the views overlap heavily — a task is in Inbox, Tasks and Library at once — and
  // keying on the id alone let whichever view fetched last steal the row out of the others' caches.
  // A cache from the one-row-per-document schema is simply rebuilt on the next fetch.
  if (db.prepare("SELECT count(*) n FROM pragma_table_info('nodes') WHERE pk > 0").get().n !== 2) db.exec('DROP TABLE IF EXISTS nodes');
  db.exec(`CREATE TABLE IF NOT EXISTS nodes (
    id TEXT NOT NULL, section TEXT NOT NULL, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
    icon TEXT, meta TEXT, tags TEXT NOT NULL DEFAULT '[]', sortKey TEXT NOT NULL, updatedAt TEXT NOT NULL,
    PRIMARY KEY (section, id))`);
  db.exec("DROP TABLE IF EXISTS icons"); // app-local custom icons were removed (#224); an old cache still carries the table
  db.exec('CREATE TABLE IF NOT EXISTS sensitive_nodes (id TEXT PRIMARY KEY)'); // app-local sensitive documents
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'); // JSON values (task filter, ...)
}

// Rows are display data: a tags column that is not a JSON array (older build, interrupted write) must not take a
// whole view down with it.
const parse = (r) => { if (!r) return r; let tags; try { tags = JSON.parse(r.tags); } catch { tags = []; } return { ...r, tags: Array.isArray(tags) ? tags : [] }; };

// -> { [section]: rows[] } in sortKey order (see DESC)
function list() {
  const out = {};
  for (const r of db.prepare('SELECT * FROM nodes ORDER BY sortKey').all()) (out[r.section] ||= []).push(parse(r));
  for (const s of DESC) if (out[s]) out[s].reverse();
  return out;
}

function remove(id) { db.prepare('DELETE FROM nodes WHERE id = ?').run(id); }

function get(id) {
  return parse(db.prepare('SELECT * FROM nodes WHERE id = ?').get(id));
}

const UPSERT = `INSERT INTO nodes (id, section, title, done, icon, meta, tags, sortKey, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(section, id) DO UPDATE SET title = excluded.title, done = excluded.done, icon = excluded.icon,
  meta = excluded.meta, tags = excluded.tags, sortKey = excluded.sortKey, updatedAt = excluded.updatedAt
  WHERE title IS NOT excluded.title OR done IS NOT excluded.done OR icon IS NOT excluded.icon OR meta IS NOT excluded.meta
    OR tags IS NOT excluded.tags OR sortKey IS NOT excluded.sortKey OR updatedAt IS NOT excluded.updatedAt`; // an unchanged row is no write

function upsert(r) {
  const updatedAt = r.updatedAt ?? new Date().toISOString();
  return db.prepare(UPSERT).run(r.id, r.section, r.title, r.done ? 1 : 0, r.icon ?? null, r.meta ?? null, JSON.stringify(r.tags || []), r.sortKey ?? updatedAt, updatedAt).changes;
}

// A document's title and done state are the same in every view that lists it, so a live change writes them to
// every row the id has; returns how many rows that was (0 when no view caches the document).
function setRow(id, { title, done, updatedAt = new Date().toISOString() }) {
  return db.prepare('UPDATE nodes SET title = ?, done = ?, updatedAt = ? WHERE id = ?').run(title, done ? 1 : 0, updatedAt, id).changes;
}

// Returns how many rows were actually written: a refresh that found nothing new writes nothing.
function replaceSection(section, rows) {
  db.exec('BEGIN');
  try {
    let written = 0;
    for (const r of rows) written += upsert({ ...r, section });
    // ponytail: JSON id list instead of a temp table; fine for a few hundred rows
    written += db.prepare('DELETE FROM nodes WHERE section = ? AND id NOT IN (SELECT value FROM json_each(?))').run(section, JSON.stringify(rows.map((r) => r.id))).changes;
    db.exec('COMMIT');
    return written;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function sensitiveIds() {
  return db.prepare('SELECT id FROM sensitive_nodes ORDER BY id').all().map((r) => r.id);
}

function setSensitive(id, on) {
  if (on) db.prepare('INSERT OR IGNORE INTO sensitive_nodes (id) VALUES (?)').run(id);
  else db.prepare('DELETE FROM sensitive_nodes WHERE id = ?').run(id);
}

// app settings as JSON per key; undefined when unset — or unreadable, which every caller already treats as unset
function setting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!r) return undefined;
  try { return JSON.parse(r.value); } catch { return undefined; }
}

function setSetting(key, value) {
  if (value === undefined) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

module.exports = { open, list, get, remove, upsert, setRow, replaceSection, sensitiveIds, setSensitive, setting, setSetting };
