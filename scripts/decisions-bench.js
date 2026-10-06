'use strict';
// How the Decisions API experiment (main/decisions.js) compares with what main/ai.js does today, on this Mac's own
// cached rows: how long each feature takes, and how often the two answer alike. Online, with the OpenAI API key
// Orbital keeps (read from a copy of its SQLite file, never printed), so it is not part of npm run check; nothing marked
// sensitive is sent. Both sides use the key: main/ai.js through the Responses API with the Quick AI as chosen. A ChatGPT
// sign-in adds Codex app-server's own round trip to that side (main/ai.js: 5.8 s for a Discuss with suggestion).
// node scripts/decisions-bench.js [rows]   (rows: how many titles the per-document features take, 12 by default)
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');
const SAMPLE = Number(process.argv[2]) || 12, REPEAT = 3;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-bench-')), copy = path.join(dir, 'tasks.sqlite');
fs.copyFileSync(path.join(os.homedir(), 'Library/Application Support/Orbital/tasks.sqlite'), copy);
const db = require('../db');
db.open(copy);
const settings = require('../main/settings'), flags = require('../main/flags'), ai = require('../main/ai'), decisions = require('../main/decisions');
// Types as a workspace has them, each with its own words (the cache keeps no type definitions); the same for both sides
const TYPES = [
  ['Project Task', 'A piece of work inside a project, with an owner and a due date.'],
  ['Discussion Task', 'Something to talk through with a person or a group: the title says with whom.'],
  ['Meeting notes', 'What was said and agreed in a meeting.'],
  ['Decision Record', 'One decision that was taken, why, and what it replaces.'],
  ['Person', 'Someone: a colleague, a customer or a contact.'],
  ['Goal', 'An outcome to reach this quarter or year, with how it is measured.'],
  ['Idea', 'A thought to look into later; nobody is working on it yet.'],
].map(([title, description], i) => ({ uri: 'tana:type:' + String(i).padStart(26, '0'), title, description }));
const FIELDS = ['Project Task › Due date', 'Project Task › Owner', 'Meeting notes › Attendees', 'Person › Company', 'Goal › Progress'].map((title, i) => ({ uri: 'tana:type:f' + String(i).padStart(25, '0'), title }));

const ms = (t) => Math.round(t) + ' ms';
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function timed(fn) { const t = performance.now(); const value = await fn(); return [performance.now() - t, value]; }
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
function report(name, old, now, agree, notes = []) {
  console.log('\n## ' + name + '\n  main/ai.js     ' + old + '\n  Decisions API  ' + now + (agree ? '\n  agree          ' + agree : ''));
  for (const n of notes) console.log('    ' + n);
}

(async () => {
  if (!settings.get('openaiApiKey')) throw new Error('Orbital has no OpenAI API key on this Mac');
  flags.set('decisions', true); // on the copy only
  const marked = new Set(settings.get('sensitive') || []);
  const titles = [...new Set(require('node:child_process').execFileSync('sqlite3', [copy, 'select id, title from nodes'], { encoding: 'utf8' }).trim().split('\n')
    .map((line) => line.split('|')).filter(([id, title]) => !marked.has(id) && title && title.trim()).map(([, title]) => title.trim()))];
  const sample = titles.slice(0, SAMPLE);
  const quick = await ai.options();
  console.log(titles.length + ' titles from the cache (none marked sensitive), ' + sample.length + ' for the per-document features; main/ai.js asks ' + quick.quickModel + ' at ' + quick.quickEffort);

  // Auto-translate's language check: this Mac's NaturalLanguage against a decision per text, for a whole page at once
  const other = (d) => !!d && d.p >= 0.6 && d.lang.split('-')[0] !== 'en';
  const apple = [], dec = [];
  let a = null, d = null;
  for (let i = 0; i < REPEAT; i++) { const [t1, v1] = await timed(() => ai.detectLanguages(titles)); apple.push(t1); a = v1; const [t2, v2] = await timed(() => decisions.detectLanguages(titles)); dec.push(t2); d = v2; }
  const differ = titles.map((t, i) => [t, a[i], d[i]]).filter(([, x, y]) => other(x) !== other(y));
  report('Languages: ' + titles.length + ' titles, one call (median of ' + REPEAT + ')', ms(median(apple)) + ' (Apple NaturalLanguage, on this Mac)', ms(median(dec)),
    (titles.length - differ.length) + '/' + titles.length + ' on "translate into English or not"',
    differ.map(([t, x, y]) => JSON.stringify(t) + ': Mac ' + (x ? x.lang + ' ' + x.p.toFixed(2) : '-') + ', Decisions ' + (y ? y.lang + ' ' + y.p.toFixed(2) : 'none')));

  // Discuss with: one title at a time, as the page asks
  const discuss = [[], []], pairs = [];
  for (const t of sample) {
    const [t1, v1] = await timed(() => ai.suggestDiscussWith(t)); const [t2, v2] = await timed(() => decisions.suggestDiscussWith(t));
    discuss[0].push(t1); discuss[1].push(t2); pairs.push([t, v1, v2]);
  }
  report('Discuss with: ' + sample.length + ' titles (median per title)', ms(median(discuss[0])), ms(median(discuss[1])), pairs.filter(([, x, y]) => same(x, y)).length + '/' + pairs.length,
    pairs.filter(([, x, y]) => !same(x, y)).map(([t, x, y]) => JSON.stringify(t) + ': ai ' + JSON.stringify(x) + ', Decisions ' + JSON.stringify(y)));

  // Auto-pick type: one document at a time, over the same types
  const typed = [[], []], tops = [];
  for (const t of sample) {
    const doc = { title: t, text: '', types: TYPES };
    const [t1, v1] = await timed(() => ai.classifyType(doc).catch((e) => ({ error: e.message }))); const [t2, v2] = await timed(() => decisions.classifyType(doc));
    typed[0].push(t1); typed[1].push(t2);
    const top = (v) => (v.error ? 'error' : v.choices[0].title + ' ' + Math.round(v.choices[0].p * 100) + '%');
    tops.push([t, top(v1), top(v2), !v1.error && v1.choices[0].uri === v2.choices[0].uri]);
  }
  report('Auto-pick type: ' + sample.length + ' titles, ' + TYPES.length + ' types (median per title)', ms(median(typed[0])), ms(median(typed[1])), tops.filter((x) => x[3]).length + '/' + tops.length + ' on the most likely type',
    tops.map(([t, x, y]) => JSON.stringify(t) + ': ai ' + x + ', Decisions ' + y));

  // Icons: every type and field in one go, from the whole Nucleo set
  const labels = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'build', 'nucleo-ui.json.gz')))).map((i) => i.n), items = [...TYPES, ...FIELDS];
  const [i1, p1] = await timed(() => ai.pickTypeIcons(items, labels)); const [i2, p2] = await timed(() => decisions.pickTypeIcons(items, labels));
  const valid = new Set(labels), ok = (p) => items.filter((t) => valid.has(p?.[t.uri])).length + '/' + items.length + ' named an icon that exists';
  report('Icons: ' + items.length + ' types and fields, ' + labels.length + ' icons (one batch)', ms(i1) + ', ' + ok(p1), ms(i2) + ', ' + ok(p2), items.filter((t) => p1?.[t.uri] === p2[t.uri]).length + '/' + items.length + ' the same icon',
    items.map((t) => t.title + ': ai ' + p1?.[t.uri] + ', Decisions ' + p2[t.uri]));

  // Suggest sensitive marks: new, so only its own time; what it flags is for a person to judge
  const odds = [], ids = titles.map((t, i) => ({ id: 'tana:text:' + String(i).padStart(26, '0'), text: t }));
  let flagged = [];
  for (let i = 0; i < REPEAT; i++) { const [t, v] = await timed(() => decisions.suggestSensitive(ids)); odds.push(t); flagged = v; }
  const likely = flagged.map((x, i) => [titles[i], x.p]).filter(([, p]) => p >= 0.5).sort((x, y) => y[1] - x[1]);
  report('Suggest sensitive marks: ' + titles.length + ' titles, one call (median of ' + REPEAT + ')', 'none: a new feature', ms(median(odds)) + ', ' + likely.length + ' at 50% or more', '',
    likely.map(([t, p]) => Math.round(p * 100) + '% ' + JSON.stringify(t)));
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
