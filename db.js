const { DatabaseSync } = require('node:sqlite');

let db;
const DESC = new Set(['tasks']); // tasks newest first; every other section ascending by sortKey

function open(path) {
  db = new DatabaseSync(path);
  db.exec('DROP TABLE IF EXISTS tasks'); // pre-sections schema; the cache is rebuilt on the next refresh
  db.exec(`CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY, section TEXT NOT NULL, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
    icon TEXT, meta TEXT, tags TEXT NOT NULL DEFAULT '[]', sortKey TEXT NOT NULL, updatedAt TEXT NOT NULL)`);
  db.exec('CREATE TABLE IF NOT EXISTS icons (id TEXT PRIMARY KEY, svg TEXT NOT NULL)'); // app-local custom document icons
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'); // JSON values (task filter, ...)
}

const parse = (r) => r && { ...r, tags: JSON.parse(r.tags) };

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
  ON CONFLICT(id) DO UPDATE SET section = excluded.section, title = excluded.title, done = excluded.done, icon = excluded.icon,
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

// app settings as JSON per key; undefined when unset
function setting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? JSON.parse(r.value) : undefined;
}

function setSetting(key, value) {
  if (value === undefined) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

module.exports = { open, list, get, remove, upsert, replaceSection, icon, setIcon, setting, setSetting };
