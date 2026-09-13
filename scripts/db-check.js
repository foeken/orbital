const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('../db');

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tana-db-')), 'tasks.sqlite');
db.open(file);

db.replaceFromTana([
  { id: 'tana:text:a', title: 'A', done: 0, space: 'Work', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'tana:text:b', title: 'B', done: 0, space: null, updatedAt: '2026-01-02T00:00:00Z' },
]);
assert.strictEqual(db.list().length, 2);
assert.strictEqual(db.list()[0].id, 'tana:text:b', 'sorted by updatedAt desc');

db.setContent('tana:text:a', 'body');
const edited = db.update('tana:text:a', { title: 'A2', done: 1 });
assert.strictEqual(edited.dirty, 1);
assert.strictEqual(edited.title, 'A2');
assert.strictEqual(edited.done, 1);
assert.deepStrictEqual(db.dirtyRows().map((r) => r.id), ['tana:text:a']);

// dirty row keeps local title/done, non-dirty b is dropped (not in pulled set), content survives null
db.replaceFromTana([
  { id: 'tana:text:a', title: 'A-remote', done: 0, space: 'Work2', updatedAt: '2026-01-03T00:00:00Z' },
  { id: 'tana:text:c', title: 'C', done: 0, space: null, updatedAt: '2026-01-04T00:00:00Z' },
]);
const a = db.get('tana:text:a');
assert.strictEqual(a.title, 'A2');
assert.strictEqual(a.done, 1);
assert.strictEqual(a.dirty, 1);
assert.strictEqual(a.space, 'Work2');
assert.strictEqual(a.content, 'body');
assert.strictEqual(db.get('tana:text:b'), undefined);
assert.ok(db.get('tana:text:c'));

db.markClean('tana:text:a');
db.replaceFromTana([{ id: 'tana:text:a', title: 'A-remote', done: 0, space: null, updatedAt: '2026-01-05T00:00:00Z' }]);
assert.strictEqual(db.get('tana:text:a').title, 'A-remote');
assert.strictEqual(db.get('tana:text:a').content, 'body');
assert.strictEqual(db.list().length, 1);

assert.throws(() => db.update('nope', { title: 'x' }));

fs.rmSync(path.dirname(file), { recursive: true });
console.log('db-check ok');
