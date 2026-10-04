#!/usr/bin/env node
'use strict';
// What every workflow in .github/workflows must keep to, so a required check means what it says and a pull request,
// a fork's among them, runs with nothing it could steal (AGENTS.md, Pull requests; docs/WORKFLOW.md):
//   - no pull_request_target or workflow_run: both run with the repository's own token and secrets beside the pull
//     request's code. Every workflow here runs a pull request's code as pull_request, read-only.
//   - a top-level permissions block, and nothing written (": write") in one a pull request triggers
//   - no secrets.* in a workflow a pull request triggers: there are none to give a fork, and none to leak
//   - no ${{ github.event.* }} or github.head_ref inside a run script: a branch name or a title is the author's text,
//     and pasted into a shell it runs. Pass it through env: and quote it.
//   - every actions/checkout sets persist-credentials: false, so the code it checks out cannot read the job's token
//     out of .git/config
//   - a draft runs only the secrets scan: every other job of a pull request's workflow that would start on its own
//     says if: github.event.pull_request.draft != true
//   - a required check is never skipped under its own name: GitHub counts a skipped job as passed. On a ready pull
//     request it runs (a verdict with always(), needing every other job of its workflow); on a draft, where it is
//     skipped, its name is "<check> (not run on drafts)". A workflow holding one runs on ready_for_review and
//     converted_to_draft, and has no paths filter (a filtered-out workflow leaves its check pending forever)
//   - no other job anywhere takes a required check's name
//   - no unquoted value holds ": ", which YAML reads as a key and GitHub refuses the whole file for
//   node scripts/workflow-check.js          the repository's workflows (npm run check)
//   node scripts/workflow-check.js --self   the rules on made-up workflows, then the real ones
const fs = require('node:fs');
const path = require('node:path');

// the checks the rulesets would require (docs/WORKFLOW.md), each the job of one workflow; a verdict job always runs
const REQUIRED = {
  gate: { file: 'checks.yml', verdict: true },
  ready: { file: 'ready.yml', verdict: true },
  platforms: { file: 'platforms.yml' },
  secrets: { file: 'ci.yml' },
};

// a draft runs these and nothing else
const DRAFT_RUNS = ['secrets'];
const DRAFT = 'github.event.pull_request.draft != true';
const draftName = (check) => "${{ github.event.pull_request.draft && '" + check + " (not run on drafts)' || '" + check + "' }}";

const indent = (l) => l.match(/^ */)[0].length;
const blank = (l) => /^\s*(#.*)?$/.test(l);

// the block under a key: the lines after it, until a line at its indent or less
function block(lines, i) {
  const at = indent(lines[i]);
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (!blank(lines[j]) && indent(lines[j]) <= at) break;
    out.push(j);
  }
  return out;
}

// the little of a workflow these rules read: top-level keys, triggers, and each job's needs, if and name
function parse(text) {
  const lines = text.split(/\r?\n/);
  const top = {};
  lines.forEach((l, i) => { const m = /^["']?([\w-]+)["']?\s*:(.*)$/.exec(l); if (m && indent(l) === 0) top[m[1]] = { i, rest: m[2].trim() }; });
  const on = top.on || top.true;
  let triggers = [];
  let onLines = [];
  if (on) {
    if (on.rest) triggers = on.rest.replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    onLines = block(lines, on.i);
    for (const j of onLines) { const m = /^ {2}([\w-]+)\s*:/.exec(lines[j]); if (m) triggers.push(m[1]); }
  }
  const jobs = {};
  if (top.jobs) {
    for (const j of block(lines, top.jobs.i)) {
      const m = /^ {2}([\w-]+)\s*:\s*$/.exec(lines[j]);
      if (!m) continue;
      const job = { id: m[1], line: j, needs: [], if: null, name: null };
      for (const k of block(lines, j)) {
        const l = lines[k];
        if (indent(l) !== 4) continue;
        let n;
        if ((n = /^ {4}needs\s*:\s*\[(.*)\]\s*$/.exec(l))) job.needs = n[1].split(',').map((s) => s.trim()).filter(Boolean);
        else if ((n = /^ {4}needs\s*:\s*([\w-]+)\s*$/.exec(l))) job.needs = [n[1]];
        else if (/^ {4}needs\s*:\s*$/.test(l)) job.needs = block(lines, k).map((x) => (/^\s*-\s*([\w-]+)/.exec(lines[x]) || [])[1]).filter(Boolean);
        else if ((n = /^ {4}if\s*:\s*(.+)$/.exec(l))) job.if = n[1].trim();
        else if ((n = /^ {4}name\s*:\s*(.+)$/.exec(l))) job.name = n[1].trim().replace(/^["']|["']$/g, '');
      }
      jobs[m[1]] = job;
    }
  }
  return { lines, top, triggers, onLines, jobs };
}

// the problems of one workflow file
function judge(file, text) {
  const errors = [];
  const w = parse(text);
  const { lines, triggers } = w;
  const err = (i, msg) => errors.push(file + (i == null ? '' : ':' + (i + 1)) + ': ' + msg);
  const pr = triggers.includes('pull_request');
  for (const t of ['pull_request_target', 'workflow_run']) if (triggers.includes(t)) err(null, t + ' runs with the repository\'s token and secrets beside code it did not write: use pull_request');
  if (!w.top.permissions) err(null, 'no top-level permissions: say what the token may do (contents: read)');
  // lines inside a block scalar (run: |) are the script's, not YAML's
  const inBlock = new Set();
  lines.forEach((l, i) => {
    const m = /^(\s*)(-\s+)?[\w-]+\s*:\s*[|>][-+]?\s*$/.exec(l);
    if (!m) return;
    const col = m[1].length + (m[2] || '').length;
    for (let j = i + 1; j < lines.length && (blank(lines[j]) || indent(lines[j]) > col); j++) inBlock.add(j);
  });
  lines.forEach((l, i) => {
    if (/^\s*#/.test(l) || inBlock.has(i)) return;
    const kv = /^\s*(-\s+)?[\w-]+\s*:\s+([^'"|>[{&*!#].*)$/.exec(l);
    if (kv && /:\s/.test(kv[2].replace(/\s#.*$/, ''))) err(i, 'an unquoted value with ": " in it is not YAML, and GitHub refuses the whole workflow: quote it or reword it');
    if (pr && /:\s*write\b|write-all/.test(l)) err(i, 'a pull request\'s workflow writes nothing');
    if (pr && /\bsecrets\./.test(l)) err(i, 'no secrets in a workflow a pull request (a fork\'s too) runs');
    const run = /^(\s*)(-\s+)?run\s*:(.*)$/.exec(l);
    if (run) {
      // an inline script is the rest of the line; a block one (| or >) the lines indented past the run key
      const col = run[1].length + (run[2] || '').length;
      const more = [];
      if (/^\s*[|>]/.test(run[3])) for (let j = i + 1; j < lines.length && (blank(lines[j]) || indent(lines[j]) > col); j++) more.push(lines[j]);
      const script = [run[3], ...more].join('\n');
      if (/\$\{\{[^}]*(github\.event\.|github\.head_ref)/.test(script)) err(i, 'an event value pasted into a script runs as shell: pass it through env: and quote it');
    }
    if (/uses\s*:\s*actions\/checkout@/.test(l)) {
      // the step: from its "- " line to the next step or the end of the steps
      let s = i;
      while (s > 0 && !/^\s*-\s/.test(lines[s])) s--;
      const at = indent(lines[s]);
      const step = [lines[s]];
      for (let j = s + 1; j < lines.length && (blank(lines[j]) || indent(lines[j]) > at); j++) step.push(lines[j]);
      if (!step.some((x) => /persist-credentials\s*:\s*false/.test(x))) err(i, 'actions/checkout without persist-credentials: false leaves the token in .git/config for the code it checked out');
    }
  });
  // A draft runs only the secrets scan. Every job of a pull request's workflow that would run without a job before it
  // (no needs, or an if that outlives its needs: always(), failure(), cancelled()) says it does not run on a draft; the
  // jobs after it are skipped with it.
  if (pr) for (const job of Object.values(w.jobs)) {
    if (DRAFT_RUNS.includes(job.id)) continue;
    const alone = !job.needs.length || /always\(\)|failure\(\)|cancelled\(\)/.test(job.if || '');
    if (alone && !(job.if || '').includes(DRAFT)) err(job.line, job.id + ' would run on a draft, which runs only the secrets scan: if: ' + DRAFT);
  }
  for (const [check, want] of Object.entries(REQUIRED)) {
    // a job taking a required check's name in another file would answer for it
    for (const job of Object.values(w.jobs)) {
      if ((job.id === check || job.name === check) && want.file !== file) err(job.line, 'a job named ' + check + ' answers for ' + want.file + '\'s required check');
    }
    if (want.file !== file) continue;
    const job = w.jobs[check];
    if (!job) { err(null, 'no job ' + check + ': it is a required check'); continue; }
    if (!pr) err(null, 'a required check runs on pull requests');
    if (DRAFT_RUNS.includes(check)) {
      if (job.if) err(job.line, check + ' runs on every pull request, a draft\'s too: no if');
      if (job.name && job.name !== check) err(job.line, check + ' is named ' + job.name + ', and the ruleset requires ' + check);
      continue;
    }
    // skipped on a draft under its own name, a required check reads as passed on that head (while a fork's ready run
    // waits for approval, say): on a draft it is named something the ruleset does not require
    if (job.name !== draftName(check)) err(job.line, check + ' is skipped on a draft, so it is named ' + draftName(check) + ': skipped under its own name it reads as passed');
    if (want.verdict) {
      if (job.if !== 'always() && ' + DRAFT) err(job.line, check + ' must run always() on a ready pull request (if: always() && ' + DRAFT + '): skipped, a required check reads as passed');
      const missing = Object.keys(w.jobs).filter((id) => id !== check && !job.needs.includes(id));
      if (missing.length) err(job.line, check + ' does not need ' + missing.join(', ') + ': a failure there would not fail it');
    } else if (job.if !== DRAFT) err(job.line, check + ' has if: ' + job.if + ': skipped on a ready pull request, a required check reads as passed');
    if (!w.onLines.some((j) => /ready_for_review/.test(lines[j]))) err(null, 'a draft made ready must run ' + check + ' (types: ready_for_review)');
    if (!w.onLines.some((j) => /converted_to_draft/.test(lines[j]))) err(null, 'a pull request back in draft must stop ' + check + ' (types: converted_to_draft cancels the run in progress)');
    if (w.onLines.some((j) => /^\s*paths(-ignore)?\s*:/.test(lines[j]))) err(null, 'a paths filter leaves the required ' + check + ' pending on every pull request it filters out');
  }
  return errors;
}

function checkRepo(dir) {
  const wf = path.join(dir, '.github', 'workflows');
  const files = fs.readdirSync(wf).filter((f) => /\.ya?ml$/.test(f));
  const errors = [];
  for (const f of files) errors.push(...judge(f, fs.readFileSync(path.join(wf, f), 'utf8')));
  for (const [check, want] of Object.entries(REQUIRED)) if (!files.includes(want.file)) errors.push(want.file + ': missing, and it holds the required check ' + check);
  return errors;
}

module.exports = { judge, parse, checkRepo, REQUIRED };

if (require.main === module) {
  if (process.argv.includes('--self')) selfCheck();
  const errors = checkRepo(path.join(__dirname, '..'));
  for (const e of errors) console.log('error: ' + e);
  if (errors.length) process.exit(1);
  console.log('workflows ok');
}

function selfCheck() {
  const assert = require('node:assert');
  const has = (errs, re) => assert.ok(errs.some((e) => re.test(e)), 'expected ' + re + ' in ' + JSON.stringify(errs));
  const wf = (o = {}) => [
    'name: Checks', 'on:', '  pull_request:', '    types: [opened, synchronize, ready_for_review, converted_to_draft]' + (o.paths ? "\n    paths: ['src/**']" : ''),
    'permissions:', '  contents: ' + (o.perm || 'read'), 'jobs:',
    '  route:', '    if: ' + (o.routeIf || DRAFT), '    runs-on: ubuntu-latest', '    steps:', '      - uses: actions/checkout@v4', '        with:', '          persist-credentials: false',
    '  desktop:', '    needs: route', "    if: needs.route.outputs.ok == 'true'", '    runs-on: ubuntu-latest', '    steps:',
    o.checkout || '      - uses: actions/checkout@v4\n        with:\n          persist-credentials: false',
    '      - run: ' + (o.run || 'npm test') + (o.env ? '\n        env:\n          TITLE: ' + o.env : ''),
    '  gate:', '    name: ' + (o.name || draftName('gate')), '    needs: ' + (o.needs || '[route, desktop]'), '    if: ' + (o.if || 'always() && ' + DRAFT), '    runs-on: ubuntu-latest', '    steps:', '      - run: echo ok',
  ].join('\n');
  assert.deepEqual(judge('checks.yml', wf()), []);
  // a draft runs only the secrets scan, and a ready pull request runs every check, none of them skipped as passed
  has(judge('checks.yml', wf({ if: 'always()', name: 'gate' })), /gate would run on a draft/);
  has(judge('checks.yml', wf({ routeIf: "github.event_name == 'pull_request'" })), /route would run on a draft/);
  has(judge('checks.yml', wf({ name: 'gate' })), /skipped under its own name it reads as passed/);
  has(judge('checks.yml', wf().replace(/\n {4}name: .*/, '')), /skipped under its own name it reads as passed/);
  has(judge('checks.yml', wf({ if: "needs.route.outputs.ok == 'true' && " + DRAFT })), /must run always\(\) on a ready pull request/);
  has(judge('checks.yml', wf({ if: '!cancelled() && ' + DRAFT })), /must run always\(\) on a ready pull request/);
  has(judge('checks.yml', wf({ needs: 'route' })), /does not need desktop/);
  has(judge('checks.yml', wf().replace('ready_for_review, ', '')), /ready_for_review/);
  has(judge('checks.yml', wf().replace(', converted_to_draft', '')), /converted_to_draft/);
  has(judge('checks.yml', wf({ paths: true })), /paths filter/);
  has(judge('checks.yml', wf({ name: "${{ github.event.pull_request.draft && 'gate (draft: not run)' || 'gate' }}" })), /is not YAML/);
  has(judge('checks.yml', wf({ run: 'echo "a: b"' })), /is not YAML/);
  assert.deepEqual(judge('checks.yml', wf({ run: '|\n          echo "a: b"' })), [], 'a script in a block scalar is the script\'s');
  // and what a pull request, a fork's too, may not have
  has(judge('checks.yml', wf({ perm: 'write' })), /writes nothing/);
  has(judge('checks.yml', wf({ run: 'echo "${{ github.event.pull_request.title }}"' })), /pasted into a script/);
  has(judge('checks.yml', wf({ run: '|\n          git checkout ${{ github.head_ref }}' })), /pasted into a script/);
  has(judge('checks.yml', wf({ checkout: '      - uses: actions/checkout@v4' })), /persist-credentials/);
  has(judge('checks.yml', wf({ checkout: '      - name: get\n        uses: actions/checkout@v4\n        with:\n          fetch-depth: 0' })), /persist-credentials/);
  has(judge('checks.yml', wf({ run: '${{ secrets.TOKEN }}' })), /no secrets/);
  has(judge('checks.yml', wf().replace('  pull_request:', '  pull_request_target:')), /pull_request_target/);
  has(judge('checks.yml', wf().replace('permissions:\n  contents: read\n', '')), /no top-level permissions/);
  // the Platforms check as it was: skipped for every pull request a bot opened, the agents' own, and run on drafts
  const platforms = (job) => ['on:', '  pull_request:', '    types: [opened, edited, synchronize, ready_for_review, converted_to_draft]', 'permissions:', '  contents: read', 'jobs:', '  platforms:', ...job, '    runs-on: ubuntu-latest', '    steps:', '      - run: node scripts/platform-check.js'].join('\n');
  const bots = judge('platforms.yml', platforms(["    if: github.event.pull_request.user.type != 'Bot'"]));
  has(bots, /skipped on a ready pull request/); has(bots, /platforms would run on a draft/);
  assert.deepEqual(judge('platforms.yml', platforms(['    name: ' + draftName('platforms'), '    if: ' + DRAFT])), []);
  has(judge('platforms.yml', platforms(['    if: ' + DRAFT])), /skipped under its own name/);
  // the secrets scan is what a draft runs
  const secrets = (job) => ['on:', '  pull_request:', 'permissions:', '  contents: read', 'jobs:', '  secrets:', ...job, '    runs-on: ubuntu-latest', '    steps:', '      - run: ./gitleaks git .'].join('\n');
  assert.deepEqual(judge('ci.yml', secrets([])), []);
  has(judge('ci.yml', secrets(['    if: ' + DRAFT])), /a draft's too/);
  // another workflow taking a required check's name
  has(judge('other.yml', ['on: push', 'permissions:', '  contents: read', 'jobs:', '  gate:', '    runs-on: ubuntu-latest', '    steps:', '      - run: true'].join('\n')), /answers for checks\.yml/);
  // an event value through env, quoted in the script, is fine
  assert.deepEqual(judge('checks.yml', wf({ run: 'echo "$TITLE"', env: '${{ github.event.pull_request.title }}' })), []);
  console.log('workflow rules ok');
}
