#!/usr/bin/env node
'use strict';
// Every pull request says, for each place a change can have to land, whether it landed there or why not (AGENTS.md,
// Every platform): the desktop app, the iPhone app, the Android app and the manual. This holds the description's
// Platforms lines to the diff, by hand before pushing:
//   node scripts/platform-check.js [--base origin/main] [--body-file pr.md]   (PR_BODY in the environment otherwise)
// It fails on a missing line, on an answer the diff contradicts, and on "not needed" with no reason given. It warns,
// without failing, where something usually follows: one phone changed and not the other, or a desktop feature the
// phones carry changed and they did not.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

// Where each platform lives. ios/engine is the engine both phones run, so it counts as both (SHARED below).
const AREAS = {
  Desktop: (f) => /^(main|renderer|sdk)\//.test(f) || /^[^/]+\.(html|css)$/.test(f) || (/^[^/]+\.js$/.test(f) && f !== 'eslint.config.js'),
  iOS: (f) => /^ios\/(Orbital|Share|OrbitalUITests|Orbital\.xcodeproj)\//.test(f) || /^ios\/[^/]+\.(plist|entitlements)$/.test(f),
  Android: (f) => /^android\//.test(f),
  Manual: (f) => /^manual\//.test(f),
};

// What both phones run (ios/engine/build.js bundles these desktop modules and the SDK into the engine): a change here
// changes both phones at once
const SHARED = /^(ios\/engine\/|sdk\/|main\/(timeline|settings|state|relay)\.js$|renderer\/segments\.js$)/;

// The desktop features the phones carry too: when one changes on the desktop, the phones usually follow. A new desktop
// feature is not here, and does not come to the phones by itself.
const MIRRORED = [
  [/^(main|renderer)\/timeline\.js$/, 'the Timeline', 'Timeline.swift, Timeline.kt'],
  [/^(renderer\/chat\.js|sdk\/chat\.js)$/, 'chats and Ask Tana', 'Pages.swift and Shell.swift, Pages.kt and Shell.kt'],
  [/^(task\.(js|html)|main\/views\.js)$/, 'Quick Add', 'QuickAdd.swift, QuickAdd.kt'],
  [/^(renderer\/access\.js|sdk\/access\.js)$/, 'Assigned to and Visible to', 'Pages.swift, Pages.kt (NodeDetails, VisibilitySheet)'],
  [/^(renderer\/document\.js|ios\/engine\/sensitive\.js)$/, 'sensitive marks', 'Timeline.swift and Pages.swift, Words.kt'],
  [/^(renderer\/segments\.js|ios\/engine\/demo\.js)$/, 'demo mode', 'Settings.swift, Settings.kt'],
  [/^(settings\.(js|html)|main\/settings\.js|main\/ai\.js|renderer\/settings\.js)$/, 'settings and the AI models', 'Settings.swift and Translator.swift, Settings.kt and ChatGPT.kt'],
  [/^(renderer\/translate\.js)$/, 'Auto-translate', 'Translator.swift, Translator.kt'],
  [/^(main\/pins\.js|sdk\/pins\.js)$/, 'pins and Today', 'Engine.swift pin, Engine.kt pin'],
  [/^(renderer\/meetingnotes\.js|main\/meeting-notes\.js)$/, 'meeting pages', 'Pages.swift, Pages.kt (MeetingSummary)'],
  [/^(renderer\/agent\.js|main\/agents\/linked\.js)$/, 'your personal agent', 'Agents.swift, Agents.kt'],
  [/^renderer\/pills\.js$/, 'a task\'s Status', 'Pages.swift, Pages.kt (NodeDetails)'],
];

const LINE = /^\s*[-*]?\s*\**\s*(Desktop|iOS|Android|Manual)\s*\**\s*:\s*\**\s*(.*)$/i;

// The description's answers: { Desktop: { updated, reason } , … }. "updated" first means it changed there; anything
// else is a reason it did not need to ("not needed: the iPhone has no canvas", "nothing user-visible").
function answers(body) {
  const out = {};
  // the template's guidance is in comments, so a line left as it came answers nothing
  for (const line of String(body || '').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const m = line.match(LINE);
    if (!m) continue;
    const name = Object.keys(AREAS).find((a) => a.toLowerCase() === m[1].toLowerCase());
    const text = m[2].replace(/\*+/g, '').trim();
    if (/^updated\b/i.test(text)) out[name] = { updated: true };
    else out[name] = { updated: false, reason: text.replace(/^(not needed|n\/a|no|none)\b\s*[:—–-]?\s*/i, '').trim() };
  }
  return out;
}

// What the description and the diff say together: { errors, warnings }. A draft leaves the manual for later (AGENTS.md:
// it is updated as the PR leaves draft), so "when ready: <the chapter>" is a fine answer then, and an error once ready.
function judge(files, body, { draft = true } = {}) {
  const errors = [], warnings = [];
  const said = answers(body);
  const touched = Object.fromEntries(Object.entries(AREAS).map(([a, test]) => [a, files.filter(test)]));
  const shared = files.filter((f) => SHARED.test(f));
  for (const area of Object.keys(AREAS)) {
    const a = said[area];
    const changed = touched[area].length > 0 || ((area === 'iOS' || area === 'Android') && shared.length > 0 && a && a.updated);
    if (!a) { errors.push(area + ': no line for it under Platforms (updated, or not needed and why)'); continue; }
    if (a.updated && !changed) errors.push(area + ': says updated, but nothing of it changed');
    if (!a.updated && touched[area].length) errors.push(area + ': says "' + a.reason + '", but ' + touched[area].length + ' of its files changed (' + touched[area].slice(0, 3).join(', ') + ')');
    if (!a.updated && !touched[area].length && a.reason.split(/\s+/).filter(Boolean).length < 2) errors.push(area + ': not needed, but why? Say it in a few words');
    if (area === 'Manual' && !a.updated && /^when ready\b/i.test(a.reason) && !draft) errors.push('Manual: the PR is ready, so its manual is due: update the chapter, its scene and its pictures, and say updated');
  }
  const ios = touched.iOS.length > 0, android = touched.Android.length > 0;
  if (ios !== android) warnings.push((ios ? 'The iPhone' : 'Android') + ' changed and ' + (ios ? 'Android' : 'the iPhone') + ' did not: the two mirror each other, so be sure "' + ((said[ios ? 'Android' : 'iOS'] || {}).reason || '') + '" is why');
  if (shared.length) warnings.push('Both phones run what changed in ' + shared.slice(0, 3).join(', ') + ': check them both');
  for (const [test, feature, where] of MIRRORED) {
    const hit = files.filter((f) => test.test(f));
    if (hit.length && !(ios && android)) warnings.push('The phones carry ' + feature + ' (' + where + '), which changed on the desktop (' + hit.join(', ') + '): they usually follow');
  }
  return { errors, warnings };
}

module.exports = { answers, judge, AREAS };

if (require.main === module) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
  if (process.argv.includes('--self')) { selfCheck(); process.exit(0); }
  const base = arg('--base') || 'origin/main';
  const body = arg('--body-file') ? fs.readFileSync(arg('--body-file'), 'utf8') : process.env.PR_BODY || '';
  const files = execFileSync('git', ['diff', '--name-only', base + '...HEAD'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  // in the workflow the pull request event says whether it is a draft; by hand, --ready checks it as one that has left draft
  let event = null;
  try { event = process.env.GITHUB_EVENT_PATH ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : null; } catch { /* no event to read */ }
  const draft = event && event.pull_request ? event.pull_request.draft === true : !process.argv.includes('--ready');
  const { errors, warnings } = judge(files, body, { draft });
  const ci = !!process.env.GITHUB_ACTIONS;
  for (const w of warnings) console.log((ci ? '::warning title=Platforms::' : 'note: ') + w);
  for (const e of errors) console.log((ci ? '::error title=Platforms::' : 'error: ') + e);
  if (errors.length) {
    console.log('\nThe description needs a Platforms section, a line each (.github/pull_request_template.md):\n- **Desktop**: updated\n- **iOS**: not needed: <why>\n- **Android**: not needed: <why>\n- **Manual**: nothing user-visible');
    process.exit(1);
  }
  console.log('platforms ok (' + files.length + ' files)');
}

// The rules on a few made-up pull requests (npm run check)
function selfCheck() {
  const assert = require('node:assert');
  const body = (d, i, a, m) => '## Platforms\n- **Desktop**: ' + d + '\n- **iOS**: ' + i + '\n- **Android**: ' + a + '\n- **Manual**: ' + m;
  const ok = (r) => assert.deepEqual(r.errors, [], JSON.stringify(r));
  // a desktop fix with a reason for each phone and the manual
  ok(judge(['renderer/edit.js'], body('updated', 'not needed: the phones have no editor', 'not needed: the phones have no editor', 'nothing user-visible')));
  // a line missing, a bare "no", an answer the diff contradicts, and "updated" with nothing changed
  assert.match(judge(['renderer/edit.js'], '- **Desktop**: updated').errors.join('|'), /iOS: no line/);
  assert.match(judge(['renderer/edit.js'], body('updated', 'no', 'not needed: desktop only', 'nothing user-visible')).errors.join('|'), /iOS: not needed, but why/);
  assert.match(judge(['android/x.kt'], body('not needed: phones', 'not needed: android only', 'not needed: just a typo', 'nothing user-visible')).errors.join('|'), /Android: says "just a typo", but 1/);
  assert.match(judge(['renderer/edit.js'], body('updated', 'updated', 'not needed: desktop only', 'nothing user-visible')).errors.join('|'), /iOS: says updated, but nothing/);
  // one phone without the other passes with a reason, and says so; the engine they share counts as both
  const one = judge(['ios/Orbital/Timeline.swift'], body('not needed: phone only', 'updated', 'not needed: no rail on Android yet', 'nothing user-visible'));
  ok(one); assert.match(one.warnings.join('|'), /The iPhone changed and Android did not/);
  ok(judge(['ios/engine/index.js'], body('not needed: engine only', 'updated', 'updated', 'nothing user-visible')));
  // a desktop feature the phones carry: noted when they did not follow
  assert.match(judge(['renderer/timeline.js'], body('updated', 'not needed: rail only', 'not needed: rail only', 'updated')).warnings.join('|'), /carry the Timeline/);
  // a line left as the template has it answers nothing
  assert.match(judge(['renderer/edit.js'], body('updated', '<!-- updated, or not needed: why -->', 'not needed: desktop only', 'nothing user-visible')).errors.join('|'), /iOS: not needed, but why/);
  // the template's old manual line still reads as a reason
  assert.equal(answers('**Manual**: nothing user-visible').Manual.reason, 'nothing user-visible');
  // a draft leaves the manual until it is ready: "when ready" passes as a draft and fails once ready
  const later = body('updated', 'not needed: desktop only', 'not needed: desktop only', 'when ready: AI & agents');
  ok(judge(['renderer/agent.js'], later, { draft: true }));
  assert.match(judge(['renderer/agent.js'], later, { draft: false }).errors.join('|'), /Manual: the PR is ready, so its manual is due/);
  ok(judge(['renderer/agent.js', 'manual/ai.html'], body('updated', 'not needed: desktop only', 'not needed: desktop only', 'updated'), { draft: false }));
  console.log('platform check rules ok');
}
