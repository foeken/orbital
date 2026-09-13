const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const db = require('../db');

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tana-db-')), 'tasks.sqlite');
// old schema with the dirty column must open cleanly
new DatabaseSync(file).exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, space TEXT, content TEXT, updatedAt TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 0)');
db.open(file);
db.open(file); // idempotent

db.replaceFromTana([
  { id: 'tana:text:a', title: 'A', done: 0, space: 'Work', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'tana:text:b', title: 'B', done: 0, space: null, updatedAt: '2026-01-02T00:00:00Z' },
]);
assert.strictEqual(db.list().length, 2);
assert.strictEqual(db.list()[0].id, 'tana:text:b', 'sorted by updatedAt desc');
assert.strictEqual(db.list()[0].dirty, undefined, 'dirty column dropped');

db.setContent('tana:text:a', 'body');
const edited = db.upsert({ ...db.get('tana:text:a'), title: 'A2', done: 1, updatedAt: '2026-01-03T00:00:00Z' });
assert.strictEqual(edited.title, 'A2');
assert.strictEqual(edited.done, 1);
assert.strictEqual(edited.content, 'body');

// live change with content null keeps cached content; upsert of an unknown id inserts
db.upsert({ id: 'tana:text:a', title: 'A3', done: 0, space: null, updatedAt: '2026-01-04T00:00:00Z' });
assert.strictEqual(db.get('tana:text:a').content, 'body');
assert.strictEqual(db.get('tana:text:a').done, 0);
db.upsert({ id: 'tana:text:new', title: 'N', done: 0 });
assert.ok(db.get('tana:text:new').updatedAt);

// pull replaces title/done, drops rows not in the set, keeps content
db.replaceFromTana([
  { id: 'tana:text:a', title: 'A-remote', done: 0, space: 'Work2', updatedAt: '2026-01-05T00:00:00Z' },
  { id: 'tana:text:c', title: 'C', done: 0, space: null, updatedAt: '2026-01-06T00:00:00Z' },
]);
const a = db.get('tana:text:a');
assert.strictEqual(a.title, 'A-remote');
assert.strictEqual(a.space, 'Work2');
assert.strictEqual(a.content, 'body');
assert.strictEqual(db.get('tana:text:b'), undefined);
assert.strictEqual(db.get('tana:text:new'), undefined);
assert.ok(db.get('tana:text:c'));
assert.strictEqual(db.list().length, 2);

fs.rmSync(path.dirname(file), { recursive: true });
console.log('db-check ok');
