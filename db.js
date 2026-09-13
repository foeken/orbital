const { DatabaseSync } = require('node:sqlite');

let db;

function open(path) {
  db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
    space TEXT, content TEXT, updatedAt TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 0)`);
}

function list() {
  return db.prepare('SELECT * FROM tasks ORDER BY updatedAt DESC').all();
}

function get(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function update(id, { title, done } = {}) {
  const row = get(id);
  if (!row) throw new Error('no task ' + id);
  db.prepare('UPDATE tasks SET title = ?, done = ?, dirty = 1, updatedAt = ? WHERE id = ?')
    .run(title ?? row.title, done ?? row.done, new Date().toISOString(), id);
  return get(id);
}

function setContent(id, content) {
  db.prepare('UPDATE tasks SET content = ? WHERE id = ?').run(content, id);
}

function dirtyRows() {
  return db.prepare('SELECT * FROM tasks WHERE dirty = 1').all();
}

function markClean(id) {
  db.prepare('UPDATE tasks SET dirty = 0 WHERE id = ?').run(id);
}

function replaceFromTana(rows) {
  const upsert = db.prepare(`INSERT INTO tasks (id, title, done, space, content, updatedAt, dirty)
    VALUES (?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET
      title = CASE WHEN dirty = 1 THEN title ELSE excluded.title END,
      done = CASE WHEN dirty = 1 THEN done ELSE excluded.done END,
      space = excluded.space,
      content = COALESCE(excluded.content, content),
      updatedAt = CASE WHEN dirty = 1 THEN updatedAt ELSE excluded.updatedAt END`);
  const ids = rows.map((r) => r.id);
  db.exec('BEGIN');
  try {
    for (const r of rows) upsert.run(r.id, r.title, r.done ? 1 : 0, r.space ?? null, r.content ?? null, r.updatedAt);
    // ponytail: JSON id list instead of a temp table; fine for a few hundred tasks
    db.prepare('DELETE FROM tasks WHERE dirty = 0 AND id NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify(ids));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { open, list, get, update, setContent, dirtyRows, markClean, replaceFromTana };
