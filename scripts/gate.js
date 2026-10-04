#!/usr/bin/env node
'use strict';
// Which checks a pull request gets, and whether every one of them passed (AGENTS.md, Pull requests; the
// orbital-workflow skill). Two workflows call it, each in two places:
//   node scripts/gate.js route --workflow gate|ready   the first job: reads the event, writes ok, kind, reason, flows and
//                                                      required to $GITHUB_OUTPUT; a rule refusing never fails the job
//   node scripts/gate.js verdict                       the last job (if: always()): NEEDS is toJSON(needs); exits 0 only
//                                                      when the route said ok and every job it required succeeded
//   node scripts/gate.js lane <name>                   exits 0 when <name> is a developer's integration lane
//   node scripts/gate.js --self                        the rules on made-up pull requests (npm run check)
// Where a pull request goes, its base, decides what it gets, and nothing about its head does:
//   into integration/<developer>   a developer's optional lane for a burst of work: the cheap checks (ready.yml: lint,
//                                  npm run check, and the user flows when the pages changed)
//   into anything else (main, a stack layer)   the full gate (checks.yml: the desktop, Android and the iPhone) on the
//                                  exact head; into main that head must also contain main, or the gate fails
// The workflows split on the base with branches/branches-ignore: 'integration/**', and each checks again here. Either
// way the verdict job is the one check a ruleset requires ("gate", "ready"). GitHub counts a skipped job as passed, so
// a required check that can be skipped is no check: the verdict always runs, and a draft, a refused route and a
// skipped, cancelled or failed job all make it fail.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

// a developer's integration lane: integration/<developer>, one lowercase name. A lane is a person's, shared by the
// agents working for them; an agent's own name is not a lane (its branches are codex/…, claude/…).
const LANE = /^integration\/([a-z0-9][a-z0-9-]{0,38})$/;
const AGENTS = /^(codex|claude|copilot|dependabot|agent|bot)(-|$)/;
// the desktop's pages: a change to them runs the user flows (npm run flows) with the cheap checks
const PAGES = [/^renderer\//, /^[^/]+\.(html|css)$/, /^(shell|help|task|update|settings|icons|preload)\.js$/, /^scripts\/flow-check\.js$/, /^package(-lock)?\.json$/];
// what each workflow runs once the route says ok; the verdict requires exactly these
const JOBS = { gate: ['desktop', 'android', 'ios'], ready: ['checks'] };

function lane(name) {
  const m = LANE.exec(name || '');
  if (!m) return { ok: false, reason: (name || '(none)') + ' is not a lane: a lane is integration/<developer>' };
  if (AGENTS.test(m[1])) return { ok: false, reason: m[1] + ' is not a developer: a lane is a person\'s, shared by the agents working for them' };
  return { ok: true, developer: m[1] };
}

// ctx: { workflow, event, base, draft, files, behind }; the head is not asked
function route(ctx) {
  const { workflow, event, base = '', draft, files = [], behind } = ctx;
  const flows = files.some((f) => PAGES.some((re) => re.test(f)));
  const no = (reason, kind = 'refused') => ({ ok: false, kind, reason, flows: false, behind: false, required: [] });
  if (event !== 'pull_request' && event !== 'workflow_dispatch') return no('runs on pull requests and by hand only, not on ' + event);
  if (draft) return no('a draft runs only the secrets scan: gh pr ready runs the checks', 'draft');
  const intoLane = /^integration\//.test(base);
  if (workflow === 'ready') {
    if (event === 'workflow_dispatch') return no('the cheap checks are for pull requests into a lane; by hand, run checks.yml');
    if (!intoLane) return no('only a pull request into integration/<developer> gets the cheap checks');
    const l = lane(base);
    if (!l.ok) return no(l.reason);
    return { ok: true, kind: 'lane', reason: '', flows, behind: false, required: flows ? [...JOBS.ready, 'flows'] : [...JOBS.ready] };
  }
  if (intoLane) return no('a pull request into a lane runs ready.yml');
  const kind = event === 'workflow_dispatch' ? 'by hand' : base === 'main' ? 'main' : 'stack layer';
  // behind main: every job still runs, and the verdict fails until main is merged in, so a green gate is always the
  // tree main gets
  const stale = base === 'main' && !!behind;
  return { ok: true, kind, reason: stale ? 'main has moved since this head: merge main into it (node scripts/promote.js refresh --pr <n>) and the gate runs again' : '', flows: true, behind: stale, required: [...JOBS.gate] };
}

// needs: toJSON(needs) of the verdict job, which needs every other job of its workflow
function verdict(needs) {
  const r = needs && needs.route;
  if (!r) return { ok: false, reason: 'no route job: the workflow is miswired' };
  if (r.result !== 'success') return { ok: false, reason: 'the route job ' + r.result };
  const out = r.outputs || {};
  if (out.ok !== 'true') return { ok: false, reason: out.reason || 'the route refused it' };
  let required;
  try { required = JSON.parse(out.required || ''); } catch { return { ok: false, reason: 'the route gave no list of required jobs' }; }
  if (!Array.isArray(required) || !required.length) return { ok: false, reason: 'the route required no jobs' };
  const bad = [];
  if (out.behind !== 'false') bad.push(out.behind === 'true' ? out.reason : 'the route did not say whether the head contains main');
  for (const job of required) {
    const n = needs[job];
    if (!n) bad.push(job + ' is required but not among the needs');
    else if (n.result !== 'success') bad.push(job + ' ' + n.result);
  }
  for (const [job, n] of Object.entries(needs)) {
    if (job === 'route' || required.includes(job)) continue;
    if (n.result !== 'skipped' && n.result !== 'success') bad.push(job + ' ' + n.result);
  }
  return bad.length ? { ok: false, reason: bad.join('; ') } : { ok: true, reason: required.join(', ') + ' passed' };
}

module.exports = { route, verdict, lane, LANE, PAGES, JOBS };

function git(args) { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }

function fromEvent(workflow) {
  const name = process.env.GITHUB_EVENT_NAME;
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event.pull_request;
  if (!pr) return { workflow, event: name };
  const files = git(['diff', '--name-only', pr.base.sha + '...' + pr.head.sha]).split('\n').filter(Boolean);
  // main as the checkout fetched it, not the event's base.sha: a re-run keeps the old event
  let behind = false;
  if (workflow === 'gate') {
    try { git(['merge-base', '--is-ancestor', 'origin/main', pr.head.sha]); } catch { behind = true; }
  }
  return { workflow, event: name, base: pr.base.ref, draft: pr.draft === true, files, behind };
}

if (require.main === module) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
  const cmd = process.argv[2];
  if (cmd === '--self') { selfCheck(); process.exit(0); }
  if (cmd === 'lane') { const l = lane(process.argv[3]); console.log(l.ok ? 'lane of ' + l.developer : l.reason); process.exit(l.ok ? 0 : 1); }
  if (cmd === 'route') {
    const workflow = arg('--workflow');
    if (!JOBS[workflow]) { console.error('route --workflow gate|ready'); process.exit(2); }
    const r = route(fromEvent(workflow));
    const lines = ['ok=' + r.ok, 'kind=' + r.kind, 'behind=' + r.behind, 'flows=' + r.flows, 'required=' + JSON.stringify(r.required), 'reason=' + r.reason.replace(/\n/g, ' ')];
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
    console.log(lines.join('\n'));
    process.exit(0);
  }
  if (cmd === 'verdict') {
    const v = verdict(JSON.parse(process.env.NEEDS || '{}'));
    console.log((v.ok ? '' : process.env.GITHUB_ACTIONS ? '::error title=Not passed::' : 'error: ') + v.reason);
    process.exit(v.ok ? 0 : 1);
  }
  console.error('usage: node scripts/gate.js route --workflow gate|ready | verdict | lane <name> | --self');
  process.exit(2);
}

function selfCheck() {
  const assert = require('node:assert');
  const out = (r) => ({ ok: String(r.ok), behind: String(r.behind), reason: r.reason, required: JSON.stringify(r.required) });
  const gate = (o) => route({ workflow: 'gate', event: 'pull_request', base: 'main', draft: false, files: ['main/views.js'], ...o });
  const ready = (o) => route({ workflow: 'ready', event: 'pull_request', base: 'integration/andre', draft: false, files: ['main/views.js'], ...o });
  const all = (r, o) => ({ route: { result: 'success', outputs: out(r) }, desktop: { result: 'success' }, android: { result: 'success' }, ios: { result: 'success' }, ...o });
  // into main: the full gate, whatever the head (a feature, a fork's, a hotfix, a lane's own branch)
  assert.deepEqual(gate().required, ['desktop', 'android', 'ios']);
  assert.equal(verdict(all(gate())).ok, true);
  // a draft is refused, never skipped, so its verdict fails rather than reading as passed
  assert.equal(verdict(all(gate({ draft: true }))).ok, false);
  assert.equal(verdict({ route: { result: 'success', outputs: out(ready({ draft: true })) } }).ok, false);
  // behind main: every job runs, and the verdict fails until main is merged in
  const behind = gate({ behind: true });
  assert.deepEqual(behind.required, ['desktop', 'android', 'ios']);
  assert.match(verdict(all(behind)).reason, /main has moved/);
  // a route that never said whether the head contains main proves nothing
  assert.equal(verdict(all(gate(), { route: { result: 'success', outputs: { ok: 'true', required: '["desktop","android","ios"]' } } })).ok, false);
  // a stack layer (any base but main or a lane) keeps the full gate; a stale base there is not main's business
  assert.equal(gate({ base: 'codex/lower', behind: true }).behind, false);
  assert.deepEqual(gate({ base: 'codex/lower' }).required, ['desktop', 'android', 'ios']);
  // into a lane: the cheap checks, with the flows when the pages changed
  assert.deepEqual(ready().required, ['checks']);
  assert.deepEqual(ready({ files: ['renderer/edit.js'] }).required, ['checks', 'flows']);
  // the lane is the base's own name: an agent's name, a capital, a nested or empty name is no lane, and fails
  for (const base of ['integration/codex', 'integration/claude-2', 'integration/Andre', 'integration/a/b', 'integration/']) assert.equal(ready({ base }).ok, false, base);
  assert.equal(lane('integration/maria').ok, true);
  // each workflow refuses the other's pull requests rather than passing them
  assert.equal(ready({ base: 'main' }).ok, false);
  assert.equal(ready({ base: 'codex/lower' }).ok, false);
  assert.equal(gate({ base: 'integration/andre' }).ok, false);
  // by hand: the whole gate, on any branch
  assert.deepEqual(route({ workflow: 'gate', event: 'workflow_dispatch' }).required, ['desktop', 'android', 'ios']);
  // the verdict: only success counts, for every required job
  for (const result of ['skipped', 'cancelled', 'failure']) assert.equal(verdict(all(gate(), { ios: { result } })).ok, false, result);
  assert.match(verdict({ route: { result: 'success', outputs: out(gate()) }, desktop: { result: 'success' }, android: { result: 'success' } }).reason, /ios is required but not among/);
  assert.equal(verdict(all(gate(), { route: { result: 'failure' } })).ok, false, 'a crashed route job');
  assert.equal(verdict(all(gate(), { route: { result: 'success', outputs: { ok: 'true', behind: 'false', required: '[]' } } })).ok, false, 'an empty list proves nothing');
  const r = { result: 'success', outputs: out(ready()) };
  assert.equal(verdict({ route: r, checks: { result: 'success' }, flows: { result: 'skipped' } }).ok, true);
  assert.equal(verdict({ route: r, checks: { result: 'success' }, flows: { result: 'failure' } }).ok, false);
  assert.equal(verdict({ route: r, checks: { result: 'skipped' }, flows: { result: 'skipped' } }).ok, false);
  console.log('gate rules ok');
}
