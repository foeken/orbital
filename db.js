const { DatabaseSync } = require('node:sqlite');

let db;
let generation = 0; // bumped on every open: whoever caches what the database says can tell a new one from the old
// Cached rows come back in the order their view's query returns them, so a boot from the cache and a refresh agree:
// meetings by start time ascending, everything else newest first (sortKey is the update time there).
const DESC = new Set(['inbox', 'tasks', 'library', 'chats']);
const TRANSLATION_TTL = 30 * 864e5; // a translation not shown for a month is asked again, and cleaned out

function open(path) {
  db = new DatabaseSync(path);
  generation++;
  // WAL: a small write is one append instead of a journal file created, synced and deleted (0.5 -> under 0.1 ms).
  // NORMAL is safe with WAL: a crash loses nothing, a power cut at most the last writes to a cache and a mirror of
  // settings Tana also holds. Another process holding the file (scripts/codex-host.js) can keep it from switching;
  // then it stays in the mode it has until the next open.
  try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* busy: the old journal still works */ }
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('DROP TABLE IF EXISTS tasks'); // pre-sections schema; the cache is rebuilt on the next refresh
  // One row per (view, document): the views overlap heavily — a task is in Inbox, Tasks and Library at once — and
  // keying on the id alone let whichever view fetched last steal the row out of the others' caches.
  // A cache from the one-row-per-document schema is simply rebuilt on the next fetch.
  if (db.prepare("SELECT count(*) n FROM pragma_table_info('nodes') WHERE pk > 0").get().n !== 2) db.exec('DROP TABLE IF EXISTS nodes');
  db.exec(`CREATE TABLE IF NOT EXISTS nodes (
    id TEXT NOT NULL, section TEXT NOT NULL, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
    icon TEXT, meta TEXT, tags TEXT NOT NULL DEFAULT '[]', sortKey TEXT NOT NULL, updatedAt TEXT NOT NULL,
    fields TEXT, PRIMARY KEY (section, id))`);
  // a row's field values (main/rows.js fieldValues), which a view grouped by a field is sectioned by: a cache from
  // before them gains the column, and each row its values at the next refresh
  if (!db.prepare("SELECT count(*) n FROM pragma_table_info('nodes') WHERE name = 'fields'").get().n) db.exec('ALTER TABLE nodes ADD COLUMN fields TEXT');
  db.exec("DROP TABLE IF EXISTS icons"); // app-local custom icons were removed (#224); an old cache still carries the table
  db.exec('CREATE TABLE IF NOT EXISTS sensitive_nodes (id TEXT PRIMARY KEY)'); // app-local sensitive documents
  // Deletions this app saw, for Cmd+K "Recently deleted". Tana keeps the document itself (a soft delete only sets
  // deletedAt, and a restore by id still works), but its graph node stops being listed, so nothing server-side can
  // answer "what did I delete": this table is the list.
  db.exec('CREATE TABLE IF NOT EXISTS deleted_nodes (id TEXT PRIMARY KEY, title TEXT NOT NULL, deletedAt TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'); // JSON values (task filter, ...)
  // Auto-translate's answers (main/ai.js translate, #547), on this machine only, keyed by a hash of the target language
  // and the exact text: an edited text is a new key, so it is asked again. lang NULL: the text was in the target
  // language already. An answer lasts a month from when it was last shown, and is cleaned out after that (here and on
  // every save). A table from an earlier build of it is simply rebuilt: it is a cache.
  if (!db.prepare("SELECT count(*) n FROM pragma_table_info('translations') WHERE name = 'usedAt'").get().n) db.exec('DROP TABLE IF EXISTS translations');
  db.exec('CREATE TABLE IF NOT EXISTS translations (key TEXT PRIMARY KEY, lang TEXT, text TEXT, usedAt INTEGER NOT NULL)');
  db.prepare('DELETE FROM translations WHERE usedAt <= ?').run(Date.now() - TRANSLATION_TTL);
}

// Rows are display data: a tags column that is not a JSON array (older build, interrupted write) must not take a
// whole view down with it.
const json = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
const parse = (r) => {
  if (!r) return r;
  const tags = json(r.tags), fields = r.fields && json(r.fields);
  return { ...r, tags: Array.isArray(tags) ? tags : [], fields: fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : undefined };
};

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

const UPSERT = `INSERT INTO nodes (id, section, title, done, icon, meta, tags, sortKey, updatedAt, fields) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(section, id) DO UPDATE SET title = excluded.title, done = excluded.done, icon = excluded.icon,
  meta = excluded.meta, tags = excluded.tags, sortKey = excluded.sortKey, updatedAt = excluded.updatedAt, fields = excluded.fields
  WHERE title IS NOT excluded.title OR done IS NOT excluded.done OR icon IS NOT excluded.icon OR meta IS NOT excluded.meta
    OR tags IS NOT excluded.tags OR sortKey IS NOT excluded.sortKey OR updatedAt IS NOT excluded.updatedAt OR fields IS NOT excluded.fields`; // an unchanged row is no write

function upsert(r) {
  const updatedAt = r.updatedAt ?? new Date().toISOString();
  return db.prepare(UPSERT).run(r.id, r.section, r.title, r.done ? 1 : 0, r.icon ?? null, r.meta ?? null, JSON.stringify(r.tags || []), r.sortKey ?? updatedAt, updatedAt, r.fields ? JSON.stringify(r.fields) : null).changes;
}

// A document's title and done state are the same in every view that lists it, so a live change writes them to
// every row the id has; returns how many rows that was (0 when no view caches the document).
function setRow(id, { title, done, updatedAt = new Date().toISOString() }) {
  return db.prepare('UPDATE nodes SET title = ?, done = ?, updatedAt = ? WHERE id = ?').run(title, done ? 1 : 0, updatedAt, id).changes;
}
// A document's field values, the same in every view that lists it (a live edit to a field); undefined clears them.
function setFields(id, fields) {
  const value = fields ? JSON.stringify(fields) : null;
  return db.prepare('UPDATE nodes SET fields = ? WHERE id = ? AND fields IS NOT ?').run(value, id, value).changes;
}
// Its type chips and icon, the same everywhere too (a retype)
function setTags(id, tags, icon) {
  return db.prepare('UPDATE nodes SET tags = ?, icon = ? WHERE id = ?').run(JSON.stringify(tags || []), icon ?? null, id).changes;
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

// A deletion, remembered under the title the document had. Deleting the same id twice keeps one row, dated the last time.
function noteDeleted(id, title) {
  db.prepare(`INSERT INTO deleted_nodes (id, title, deletedAt) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, deletedAt = excluded.deletedAt`).run(id, title || 'Untitled', new Date().toISOString());
}

// A restore (from here, from undo, or from another device) takes it off the list.
function unnoteDeleted(id) { db.prepare('DELETE FROM deleted_nodes WHERE id = ?').run(id); }

// Newest first, and only what "recently" can mean: anything older is dropped as the list is read. Deleting a
// selection writes several rows within the same millisecond, so the insertion order breaks the tie.
function deletedList(limit = 25, days = 30) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  db.prepare('DELETE FROM deleted_nodes WHERE deletedAt <= ?').run(cutoff);
  return db.prepare('SELECT id, title, deletedAt FROM deleted_nodes ORDER BY deletedAt DESC, rowid DESC LIMIT ?').all(limit);
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

// Every setting at once, for the in-memory cache main keeps (main/settings.js): the app answers a setting read on a
// hot path — every listed row asks for its type's glyph — so it is read once at open rather than per question.
function settings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) { try { out[r.key] = JSON.parse(r.value); } catch { /* an unreadable value reads as unset, as it always did */ } }
  return out;
}

// [key] -> Map of the keys answered within the month: key -> { lang, text } | null (already in the target language).
// Each one found is used now, so its month starts again.
function translations(keys, now = Date.now()) {
  const get = db.prepare('SELECT lang, text FROM translations WHERE key = ? AND usedAt > ?'), used = db.prepare('UPDATE translations SET usedAt = ? WHERE key = ?'), out = new Map();
  for (const key of keys) { const r = get.get(key, now - TRANSLATION_TTL); if (r) { out.set(key, r.lang ? { lang: r.lang, text: r.text } : null); used.run(now, key); } }
  return out;
}
// New answers in; what has not been shown for a month out, and past 5000 the least recently shown
function saveTranslations(answers, now = Date.now()) { // [[key, { lang, text } | null]]
  const put = db.prepare('INSERT INTO translations (key, lang, text, usedAt) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET lang = excluded.lang, text = excluded.text, usedAt = excluded.usedAt');
  for (const [key, found] of answers) put.run(key, found ? found.lang : null, found ? found.text : null, now);
  db.prepare('DELETE FROM translations WHERE usedAt <= ?').run(now - TRANSLATION_TTL);
  db.exec('DELETE FROM translations WHERE rowid NOT IN (SELECT rowid FROM translations ORDER BY usedAt DESC LIMIT 5000)');
}

module.exports = { open, translations, saveTranslations, list, get, remove, upsert, setRow, setFields, setTags, replaceSection, sensitiveIds, setSensitive, noteDeleted, unnoteDeleted, deletedList, setting, setSetting, settings, generation: () => generation };
