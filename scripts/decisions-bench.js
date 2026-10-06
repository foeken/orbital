'use strict';
// How the Decisions API experiment (main/decisions.js, issue #807) compares with what main/ai.js does today, on this Mac's own
// cached rows: how long each feature takes, and how often the two answer alike. Online, with the OpenAI API key
// Orbital keeps (read from a copy of its SQLite file, never printed), so it is not part of npm run check; nothing marked
// sensitive is sent. Both sides use the key: main/ai.js through the Responses API with the Quick AI as chosen. A ChatGPT
// sign-in adds Codex app-server's own round trip to that side (main/ai.js: 5.8 s for a Discuss with suggestion).
// node scripts/decisions-bench.js [rows]   (rows: how many titles the per-document features take, 12 by default)
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
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

const ms = (t) => Math.round(t) + ' ms';
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function timed(fn) { const t = performance.now(); const value = await fn(); return [performance.now() - t, value]; }
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

  // Suggest sensitive marks: new, so only its own time; what it flags is for a person to judge
  const odds = [], ids = titles.map((t, i) => ({ id: 'tana:text:' + String(i).padStart(26, '0'), text: t }));
  let flagged = [];
  for (let i = 0; i < REPEAT; i++) { const [t, v] = await timed(() => decisions.suggestSensitive(ids)); odds.push(t); flagged = v; }
  const likely = flagged.map((x, i) => [titles[i], x.p]).filter(([, p]) => p >= 0.5).sort((x, y) => y[1] - x[1]);
  report('Suggest sensitive marks: ' + titles.length + ' titles, one call (median of ' + REPEAT + ')', 'none: a new feature', ms(median(odds)) + ', ' + likely.length + ' at 50% or more', '',
    likely.map(([t, p]) => Math.round(p * 100) + '% ' + JSON.stringify(t)));
  // The smart filter: a sentence over every title, as ⌘F asks once typing pauses; what the words alone find beside it
  for (const q of ['waiting on someone else', 'anything about money or budgets', 'people and hiring matters', 'things to discuss with the heads of tech']) {
    const times = [];
    let odds = [];
    for (let i = 0; i < REPEAT; i++) { const [t, v] = await timed(() => decisions.filterRows(q, ids)); times.push(t); odds = v; }
    const words = titles.filter((t) => t.toLowerCase().includes(q)).length, meant = odds.map((x, i) => [titles[i], x.p]).filter(([, p]) => p >= 0.5).sort((x, y) => y[1] - x[1]);
    report('Smart filter "' + q + '": ' + titles.length + ' titles, one call (median of ' + REPEAT + ')', words + ' found by the words', ms(median(times)) + ', ' + meant.length + ' at 50% or more', '',
      meant.slice(0, 8).map(([t, p]) => Math.round(p * 100) + '% ' + JSON.stringify(t)));
  }
  // Ranked menus: the @ menu's documents for a line being written, and the # menu's choices for selected words
  const offered = titles.slice(0, 40);
  for (const line of ['Follow up on the Datadog cost growth with @', 'Prepare the NLT discussion on the hardware direction, see @', 'Ask about the Works Council reply in @']) {
    const times = [];
    let odds = [];
    for (let i = 0; i < REPEAT; i++) { const [t, v] = await timed(() => decisions.rankChoices('Page: Today\nWriting: ' + line, offered)); times.push(t); odds = v; }
    report('Ranked @ menu "' + line + '": ' + offered.length + ' documents (median of ' + REPEAT + ')', 'the order the search gives', ms(median(times)), '',
      odds.map((p, i) => [offered[i], p]).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([t, p]) => Math.round(p * 100) + '% ' + JSON.stringify(t)));
  }
  const kinds = ['Doc', 'Task', 'Meeting', 'Project Task', 'Discussion Task', 'Decision Record', 'Goal'];
  for (const words of ['Review Q3 hiring plan with Kor', 'We move to Postgres for Penny', 'Weekly sync with the heads of tech']) {
    const [t, odds] = await timed(() => decisions.rankChoices('Page: Today\nWriting: ' + words + '\nTyped in the menu: Make "' + words + '" a…', kinds));
    report('Ranked # menu "' + words + '"', 'Doc, Task, Meeting, then the types', ms(t), '', [odds.map((p, i) => [kinds[i], p]).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, p]) => k + ' ' + Math.round(p * 100) + '%').join(', ')]);
  }
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
