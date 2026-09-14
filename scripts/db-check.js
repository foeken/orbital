const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const db = require('../db');

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tana-db-')), 'tasks.sqlite');
// the old tasks table must be dropped on open
new DatabaseSync(file).exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, updatedAt TEXT NOT NULL)');
db.open(file);
db.open(file); // idempotent
assert.strictEqual(new DatabaseSync(file).prepare("SELECT name FROM sqlite_master WHERE name = 'tasks'").get(), undefined, 'old table dropped');

db.replaceSection('tasks', [
  { id: 'tana:text:a', title: 'A', done: 0, icon: 'task', tags: [{ label: 'task', color: 'grey' }], sortKey: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'tana:text:b', title: 'B', done: 0, icon: 'task', tags: [{ label: 'task', color: 'grey' }, { label: 'Project', color: 'grey' }], sortKey: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
]);
db.replaceSection('meetings', [
  { id: 'tana:event:y', title: 'Y', icon: 'meeting', meta: 'Tue 9:00–9:30', tags: [{ label: 'meeting', color: 'gold' }], sortKey: '2026-01-06T08:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'tana:event:x', title: 'X', icon: 'meeting', meta: 'Mon, all day', tags: [{ label: 'meeting', color: 'gold' }], sortKey: '2026-01-05T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
]);
let all = db.list();
assert.deepStrictEqual(Object.keys(all).sort(), ['meetings', 'tasks']);
assert.deepStrictEqual(all.tasks.map((r) => r.id), ['tana:text:b', 'tana:text:a'], 'tasks: sortKey desc');
assert.deepStrictEqual(all.meetings.map((r) => r.id), ['tana:event:x', 'tana:event:y'], 'meetings: sortKey asc');
assert.deepStrictEqual(all.tasks[0].tags, [{ label: 'task', color: 'grey' }, { label: 'Project', color: 'grey' }], 'tags round-trip as JSON');
assert.strictEqual(all.meetings[0].meta, 'Mon, all day');
assert.strictEqual(all.meetings[0].done, 0);
assert.deepStrictEqual(Object.keys(all.tasks[0]).sort(), ['done', 'icon', 'id', 'meta', 'section', 'sortKey', 'tags', 'title', 'updatedAt']);

const edited = db.upsert({ ...db.get('tana:text:a'), title: 'A2', done: 1, updatedAt: '2026-01-03T00:00:00Z' });
assert.strictEqual(edited.title, 'A2');
assert.strictEqual(edited.done, 1);
assert.strictEqual(edited.section, 'tasks');
db.upsert({ id: 'tana:text:new', section: 'tasks', title: 'N', done: 0 });
assert.ok(db.get('tana:text:new').updatedAt && db.get('tana:text:new').sortKey);
assert.deepStrictEqual(db.get('tana:text:new').tags, []);
// a live title/done change reaches every view that caches the document, not only the row get() happens to return
db.upsert({ id: 'tana:text:a', section: 'inbox', title: 'A2', done: 1 });
assert.strictEqual(db.setRow('tana:text:a', { title: 'A3', done: 0 }), 2, 'both cached rows were rewritten');
assert.deepStrictEqual([db.list().tasks.find((r) => r.id === 'tana:text:a').title, db.list().inbox[0].title], ['A3', 'A3']);
assert.strictEqual(db.setRow('tana:text:none', { title: 'x', done: 0 }), 0, 'an uncached document is no row at all');
db.replaceSection('inbox', []);

// replacing one section replaces title/done and drops its unlisted rows, leaving other sections alone
db.replaceSection('tasks', [
  { id: 'tana:text:a', title: 'A-remote', done: 0, sortKey: '2026-01-05T00:00:00Z', updatedAt: '2026-01-05T00:00:00Z' },
  { id: 'tana:text:c', title: 'C', done: 0, sortKey: '2026-01-06T00:00:00Z', updatedAt: '2026-01-06T00:00:00Z' },
]);
assert.strictEqual(db.get('tana:text:a').title, 'A-remote');
assert.strictEqual(db.get('tana:text:b'), undefined);
assert.strictEqual(db.get('tana:text:new'), undefined);
all = db.list();
assert.deepStrictEqual(all.tasks.map((r) => r.id), ['tana:text:c', 'tana:text:a']);
assert.strictEqual(all.meetings.length, 2, 'other section untouched');
db.replaceSection('meetings', []);
assert.deepStrictEqual(Object.keys(db.list()), ['tasks']);

// icons: app-local SVG per document, independent of the nodes cache
assert.strictEqual(db.icon('tana:text:a'), null);
db.setIcon('tana:text:a', '<svg viewBox="0 0 16 16"></svg>');
db.setIcon('tana:text:a', '<svg viewBox="0 0 16 16"><circle r="8"/></svg>'); // upsert
assert.strictEqual(db.icon('tana:text:a'), '<svg viewBox="0 0 16 16"><circle r="8"/></svg>');
db.replaceSection('tasks', []);
assert.strictEqual(db.icon('tana:text:a'), '<svg viewBox="0 0 16 16"><circle r="8"/></svg>', 'icon survives the row');
db.setIcon('tana:text:a', null);
assert.strictEqual(db.icon('tana:text:a'), null);

// sensitive documents: app-local ids, independent of the nodes cache
assert.deepStrictEqual(db.sensitiveIds(), []);
db.setSensitive('tana:text:b', true);
db.setSensitive('tana:text:a', true);
db.setSensitive('tana:text:a', true); // idempotent
assert.deepStrictEqual(db.sensitiveIds(), ['tana:text:a', 'tana:text:b']);
db.replaceSection('tasks', []);
assert.deepStrictEqual(db.sensitiveIds(), ['tana:text:a', 'tana:text:b'], 'sensitive marks survive the row cache');
db.setSensitive('tana:text:a', false);
assert.deepStrictEqual(db.sensitiveIds(), ['tana:text:b']);

// a row whose tags column is not a JSON array (older build, interrupted write) still reads as a row
db.upsert({ id: 'tana:text:bad', section: 'tasks', title: 'Bad', done: 0 });
new DatabaseSync(file).prepare("UPDATE nodes SET tags = 'not json' WHERE id = ?").run('tana:text:bad');
assert.deepStrictEqual(db.get('tana:text:bad').tags, []);
assert.strictEqual(db.list().tasks.length, 1, 'one unreadable row does not take the section down');
db.replaceSection('tasks', []);

// settings: JSON per key
assert.strictEqual(db.setting('taskFilter'), undefined);
db.setSetting('taskFilter', { states: null, assignee: 'anyone' });
assert.deepStrictEqual(db.setting('taskFilter'), { states: null, assignee: 'anyone' });
db.setSetting('taskFilter', { states: ['open'], assignee: 'me' }); // upsert
assert.deepStrictEqual(db.setting('taskFilter').states, ['open']);
db.setSetting('taskFilter', undefined);
assert.strictEqual(db.setting('taskFilter'), undefined);
// a value an older build or an interrupted write left unparseable reads as unset, like the tags column above
new DatabaseSync(file).prepare("INSERT INTO settings (key, value) VALUES ('viewFilter:tasks', '{not json')").run();
assert.strictEqual(db.setting('viewFilter:tasks'), undefined, 'a corrupt setting is unset, not a crash');
db.setSetting('viewFilter:tasks', undefined);

// The views overlap: one document is in Inbox, Tasks and Library at once, and each view caches its own list.
db.replaceSection('tasks', [{ id: 'tana:text:shared', title: 'Shared', done: 0, sortKey: '1', updatedAt: '1' }]);
db.replaceSection('library', [{ id: 'tana:text:shared', title: 'Shared', done: 0, sortKey: '1', updatedAt: '1' }]);
assert.strictEqual((db.list().tasks || []).length, 1, 'a second view caching the same document does not steal it from the first');
assert.strictEqual((db.list().library || []).length, 1);
db.replaceSection('library', []);
assert.strictEqual((db.list().tasks || []).length, 1, 'and emptying one view leaves the other view its rows');
db.replaceSection('tasks', []);

// A cache written by the one-row-per-document schema is rebuilt rather than read back wrong.
const legacy = path.join(path.dirname(file), 'legacy.sqlite');
const old = new DatabaseSync(legacy);
old.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY, section TEXT NOT NULL, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, icon TEXT, meta TEXT, tags TEXT NOT NULL DEFAULT '[]', sortKey TEXT NOT NULL, updatedAt TEXT NOT NULL)");
old.exec("INSERT INTO nodes (id, section, title, sortKey, updatedAt) VALUES ('tana:text:old', 'tasks', 'Old', '1', '1')");
old.close();
db.open(legacy);
assert.deepStrictEqual(db.list(), {}, 'the old cache is dropped, not carried over with the wrong key');
db.replaceSection('tasks', [{ id: 'tana:text:shared', title: 'Shared', done: 0, sortKey: '1', updatedAt: '1' }]);
db.replaceSection('inbox', [{ id: 'tana:text:shared', title: 'Shared', done: 0, sortKey: '1', updatedAt: '1' }]);
assert.strictEqual((db.list().tasks || []).length + (db.list().inbox || []).length, 2, 'and the rebuilt cache holds one row per view');

fs.rmSync(path.dirname(file), { recursive: true });
console.log('db-check ok');
