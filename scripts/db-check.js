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

fs.rmSync(path.dirname(file), { recursive: true });
console.log('db-check ok');
