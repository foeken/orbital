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
// WAL: a setting write at startup is an append, not a rollback journal created, synced and deleted each time.
assert.strictEqual(new DatabaseSync(file).prepare('PRAGMA journal_mode').get().journal_mode, 'wal', 'the database is in WAL mode');
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

assert.strictEqual(db.upsert({ ...db.get('tana:text:a'), title: 'A2', done: 1, updatedAt: '2026-01-03T00:00:00Z' }), 1, 'a changed row is one write');
const edited = db.get('tana:text:a');
assert.strictEqual(edited.title, 'A2');
assert.strictEqual(edited.done, 1);
assert.strictEqual(edited.section, 'tasks');
assert.strictEqual(db.upsert({ ...db.get('tana:text:a') }), 0, 'and the same row again is no write at all');
db.upsert({ id: 'tana:text:new', section: 'tasks', title: 'N', done: 0 });
assert.ok(db.get('tana:text:new').updatedAt && db.get('tana:text:new').sortKey);
assert.deepStrictEqual(db.get('tana:text:new').tags, []);
// a live title/done change reaches every view that caches the document, not only the row get() happens to return
db.upsert({ id: 'tana:text:a', section: 'inbox', title: 'A2', done: 1 });
assert.strictEqual(db.setRow('tana:text:a', { title: 'A3', done: 0 }), 2, 'both cached rows were rewritten');
assert.deepStrictEqual([db.list().tasks.find((r) => r.id === 'tana:text:a').title, db.list().inbox[0].title], ['A3', 'A3']);
assert.strictEqual(db.setRow('tana:text:none', { title: 'x', done: 0 }), 0, 'an uncached document is no row at all');
db.replaceSection('inbox', []);
// a refresh that found nothing new writes nothing: the SQLite file stays untouched thirty seconds at a time
const same = db.list().tasks.map(({ section, ...r }) => r);
assert.strictEqual(db.replaceSection('tasks', same), 0, 'an unchanged section is zero writes');
// inbox, library and chats read back newest first like tasks; only meetings are ascending
db.replaceSection('library', [{ id: 'tana:text:old', title: 'old', sortKey: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }, { id: 'tana:text:newer', title: 'newer', sortKey: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' }]);
assert.deepStrictEqual(db.list().library.map((r) => r.title), ['newer', 'old'], 'library: newest first, as its query returns it');
db.replaceSection('library', []);

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
db.setSetting('openaiApiKey', 'sk-test-local');
assert.strictEqual(db.setting('openaiApiKey'), 'sk-test-local', 'API keys persist in local SQLite settings');
db.setSetting('openaiApiKey', undefined);

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

// Recently deleted (Cmd+K): a deleted document leaves the graph, so this list is the only way back to one.
db.noteDeleted('tana:text:gone1', 'First');
db.noteDeleted('tana:text:gone2', 'Second');
db.noteDeleted('tana:text:gone2', 'Second, renamed before it went'); // deleting the same id again is one row, re-dated
assert.deepStrictEqual(db.deletedList().map((d) => d.title), ['Second, renamed before it went', 'First'], 'newest first, one row per document');
db.noteDeleted('tana:text:untitled', '');
assert.strictEqual(db.deletedList()[0].title, 'Untitled', 'a document with no title is still offered');
db.unnoteDeleted('tana:text:gone1');
assert.strictEqual(db.deletedList().some((d) => d.id === 'tana:text:gone1'), false, 'a restore takes it off the list');
new DatabaseSync(legacy).exec("INSERT INTO deleted_nodes (id, title, deletedAt) VALUES ('tana:text:ancient', 'Ancient', '2020-01-01T00:00:00.000Z')");
assert.strictEqual(db.deletedList().some((d) => d.id === 'tana:text:ancient'), false, 'and nothing older than a month is "recently"');
assert.strictEqual(db.deletedList(1).length, 1, 'the list is capped');

// The callback a Codex task makes on itself (scripts/agent-link.js): it runs as a separate process while the app is
// open, so it is checked the way the task runs it — as a command, against a database file of its own.
{
  const link = path.join(__dirname, 'agent-link.js');
  const store = path.join(path.dirname(file), 'link.sqlite');
  const run = (args) => {
    const r = require('node:child_process').spawnSync(process.execPath, [link, ...args], { encoding: 'utf8', env: { ...process.env, ORBITAL_DB: store } });
    return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  };
  const NODE = 'tana:text:01examplea0000000000000000', THREAD = '01a0b355-2197-7311-b576-ff4bd9c8901e';
  assert.strictEqual(run(['--node', NODE]).code, 1, 'an unlinked node answers with nothing and says so in the exit code');
  const linked = run(['--node', NODE, '--thread', THREAD]);
  assert.strictEqual(linked.code, 0);
  assert.match(linked.out, /^linked /, 'registering reports what it wrote');
  const again = run(['--node', NODE, '--thread', THREAD]);
  assert.strictEqual(again.code, 0, 'running it twice is not an error: a task may retry');
  assert.match(again.out, /^already linked /, 'and says the link was already there rather than writing again');
  assert.strictEqual(run(['--node', NODE]).out, THREAD, 'the link reads back');
  assert.strictEqual(run(['--node', 'not-a-node', '--thread', THREAD]).code, 2, 'a node that is not a Tana uri is refused');
  assert.strictEqual(run(['--node', NODE, '--thread', 'nonsense']).code, 2, 'so is a thread id that is not one');
  assert.strictEqual(run(['--node', NODE]).out, THREAD, 'and a refused call changes nothing');
  console.log('db-check: agent-link records nodeId -> threadId, validated and idempotent');
}

// userdata.js: the folder this app keeps its login, cache and settings mirror in is named after the app, and the
// app is Orbital now. A new install starts there; an install carrying the old name is moved once, by whatever boots
// the app, and never by a helper that only reads.
{
  const { userDataDir, DIR, OLD_DIR } = require('../userdata');
  const appData = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-appdata-'));

  const fresh = appData();
  assert.strictEqual(userDataDir(fresh, { migrate: true }), path.join(fresh, DIR), 'a new install is told the app’s own name');
  assert.strictEqual(fs.existsSync(path.join(fresh, DIR)), false, 'and the folder is left for Electron to create');

  const older = appData();
  fs.mkdirSync(path.join(older, OLD_DIR));
  fs.writeFileSync(path.join(older, OLD_DIR, 'tasks.sqlite'), 'rows');
  assert.strictEqual(userDataDir(older), path.join(older, OLD_DIR), 'a reader is sent to the old folder where it still is');
  assert.ok(fs.existsSync(path.join(older, OLD_DIR)), 'and reading never moves it out from under a running app');
  assert.strictEqual(userDataDir(older, { migrate: true }), path.join(older, DIR), 'booting the app moves it');
  assert.strictEqual(fs.readFileSync(path.join(older, DIR, 'tasks.sqlite'), 'utf8'), 'rows', 'with everything that was in it');
  assert.strictEqual(fs.existsSync(path.join(older, OLD_DIR)), false, 'leaving no second folder to drift from it');
  assert.strictEqual(userDataDir(older, { migrate: true }), path.join(older, DIR), 'and the next boot has nothing left to do');

  const both = appData();
  fs.mkdirSync(path.join(both, OLD_DIR));
  fs.mkdirSync(path.join(both, DIR));
  assert.strictEqual(userDataDir(both, { migrate: true }), path.join(both, DIR), 'the current name wins when both exist');
  assert.ok(fs.existsSync(path.join(both, OLD_DIR)), 'and the old one is left alone rather than merged or deleted');

  // A move that cannot happen must not cost anybody their login: the old folder stays in use and is tried again.
  const locked = appData();
  fs.mkdirSync(path.join(locked, OLD_DIR));
  fs.chmodSync(locked, 0o500);
  try {
    assert.strictEqual(userDataDir(locked, { migrate: true }), path.join(locked, OLD_DIR), 'a refused move keeps the old folder in use');
  } finally {
    fs.chmodSync(locked, 0o700);
  }
  for (const dir of [fresh, older, both, locked]) fs.rmSync(dir, { recursive: true, force: true });
  console.log('db-check: the app data folder is the app’s name, and an older one is moved there once');
}

// Auto-translate's answers (#547): a month from when each was last shown, then asked again and cleaned out
{
  db.open(file); // the checks above moved on to another file
  const day = 864e5, t0 = Date.UTC(2026, 0, 1);
  db.saveTranslations([['k-used', { lang: 'Dutch', text: 'Hello' }], ['k-idle', null]], t0);
  assert.deepStrictEqual([...db.translations(['k-used', 'k-idle', 'k-none'], t0 + day)], [['k-used', { lang: 'Dutch', text: 'Hello' }], ['k-idle', null]], 'answers come back, "already in the language" too, and an unknown key does not');
  assert.strictEqual(db.translations(['k-used'], t0 + 25 * day).size, 1, 'shown again within the month: its month starts again');
  assert.deepStrictEqual([...db.translations(['k-used', 'k-idle'], t0 + 40 * day).keys()], ['k-used'], 'the one shown on day 25 lasts past day 30; the one not shown since day 1 has expired');
  db.saveTranslations([['k-new', null]], t0 + 40 * day);
  assert.strictEqual(new DatabaseSync(file).prepare("SELECT count(*) n FROM translations WHERE key = 'k-idle'").get().n, 0, 'and a save cleans the expired ones out');
  db.saveTranslations([['k-new', null]], Date.now()); db.open(file); db.saveTranslations([], Date.now());
  assert.deepStrictEqual(new DatabaseSync(file).prepare('SELECT key FROM translations ORDER BY key').all().map((r) => r.key), ['k-new'], 'opening the database cleans out what has not been shown for a month');
}

fs.rmSync(path.dirname(file), { recursive: true });
console.log('db-check ok');
