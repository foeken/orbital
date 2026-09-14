const { DatabaseSync } = require('node:sqlite');

let db;
const DESC = new Set(['tasks']); // tasks newest first; every other section ascending by sortKey

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
  db.exec('CREATE TABLE IF NOT EXISTS icons (id TEXT PRIMARY KEY, svg TEXT NOT NULL)'); // app-local custom document icons
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
  meta = excluded.meta, tags = excluded.tags, sortKey = excluded.sortKey, updatedAt = excluded.updatedAt`;

function upsert(r) {
  const updatedAt = r.updatedAt ?? new Date().toISOString();
  db.prepare(UPSERT).run(r.id, r.section, r.title, r.done ? 1 : 0, r.icon ?? null, r.meta ?? null, JSON.stringify(r.tags || []), r.sortKey ?? updatedAt, updatedAt);
  return get(r.id);
}

function replaceSection(section, rows) {
  db.exec('BEGIN');
  try {
    for (const r of rows) upsert({ ...r, section });
    // ponytail: JSON id list instead of a temp table; fine for a few hundred rows
    db.prepare('DELETE FROM nodes WHERE section = ? AND id NOT IN (SELECT value FROM json_each(?))').run(section, JSON.stringify(rows.map((r) => r.id)));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// custom icon (raw SVG) per document id; null removes it
function icon(id) {
  const r = db.prepare('SELECT svg FROM icons WHERE id = ?').get(id);
  return r ? r.svg : null;
}

function setIcon(id, svg) {
  if (svg == null) db.prepare('DELETE FROM icons WHERE id = ?').run(id);
  else db.prepare('INSERT INTO icons (id, svg) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET svg = excluded.svg').run(id, svg);
}

function sensitiveIds() {
  return db.prepare('SELECT id FROM sensitive_nodes ORDER BY id').all().map((r) => r.id);
}

function setSensitive(id, on) {
  if (on) db.prepare('INSERT OR IGNORE INTO sensitive_nodes (id) VALUES (?)').run(id);
  else db.prepare('DELETE FROM sensitive_nodes WHERE id = ?').run(id);
}

// app settings as JSON per key; undefined when unset
function setting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? JSON.parse(r.value) : undefined;
}

function setSetting(key, value) {
  if (value === undefined) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

module.exports = { open, list, get, remove, upsert, replaceSection, icon, setIcon, sensitiveIds, setSensitive, setting, setSetting };
