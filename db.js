const { DatabaseSync } = require('node:sqlite');

let db;

function open(path) {
  db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, updatedAt TEXT NOT NULL)`);
  for (const col of ['dirty', 'space', 'content']) { try { db.exec('ALTER TABLE tasks DROP COLUMN ' + col); } catch { /* already gone */ } }
}

function list() {
  return db.prepare('SELECT * FROM tasks ORDER BY updatedAt DESC').all();
}

function get(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

const UPSERT = `INSERT INTO tasks (id, title, done, updatedAt) VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET title = excluded.title, done = excluded.done, updatedAt = excluded.updatedAt`;

function upsert(r) {
  db.prepare(UPSERT).run(r.id, r.title, r.done ? 1 : 0, r.updatedAt ?? new Date().toISOString());
  return get(r.id);
}

function replaceFromTana(rows) {
  db.exec('BEGIN');
  try {
    for (const r of rows) upsert(r);
    // ponytail: JSON id list instead of a temp table; fine for a few hundred tasks
    db.prepare('DELETE FROM tasks WHERE id NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify(rows.map((r) => r.id)));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { open, list, get, upsert, replaceFromTana };
