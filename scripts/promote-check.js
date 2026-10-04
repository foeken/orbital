#!/usr/bin/env node
'use strict';
// scripts/promote.js on throwaway repositories: a bare origin, a developer's clone that lands work, and the clone the
// tool runs in, with a stand-in for GitHub that merges as GitHub does (a merge commit of the head onto the base, refused
// when the head moved). Each step is a way a change could reach main untested or lose a commit (npm run check).
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { make, MARK } = require('./promote.js');

// nobody's own git config or hooks (a global pre-push hook refuses pushes to main) reach the throwaway repositories
Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-check-'));
const g = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const short = (s) => s.slice(0, 7);

const origin = path.join(tmp, 'origin.git');
const dev = path.join(tmp, 'dev');
const tool = path.join(tmp, 'tool');
g(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
g(tmp, 'clone', '-q', origin, dev);
const write = (f, s) => fs.writeFileSync(path.join(dev, f), s);
write('package.json', JSON.stringify({ name: 't', version: '1.0.0' }, null, 2) + '\n');
write('package-lock.json', JSON.stringify({ name: 't', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 't', version: '1.0.0' } } }, null, 2) + '\n');
write('a.txt', 'a\n');
g(dev, 'add', '.'); g(dev, 'commit', '-q', '-m', 'start'); g(dev, 'push', '-q', 'origin', 'HEAD:main');
g(dev, 'push', '-q', 'origin', 'main:refs/heads/integration/andre');
g(tmp, 'clone', '-q', origin, tool);

// a commit on a branch of origin (from main when the branch is new), as a merged pull request leaves it
function land(branch, file, content, from = 'main') {
  g(dev, 'fetch', '-q', 'origin');
  const exists = g(dev, 'ls-remote', 'origin', 'refs/heads/' + branch) !== '';
  g(dev, 'checkout', '-q', '-B', branch, 'origin/' + (exists ? branch : from));
  write(file, content);
  g(dev, 'add', '.'); g(dev, 'commit', '-q', '-m', file);
  g(dev, 'push', '-q', 'origin', 'HEAD:refs/heads/' + branch);
  return g(dev, 'rev-parse', 'HEAD');
}
const tip = (ref) => g(origin, 'rev-parse', ref);
const holds = (ref, sha) => { try { g(origin, 'merge-base', '--is-ancestor', sha, ref); return true; } catch { return false; } };
const setRef = (ref, sha) => g(origin, 'update-ref', ref, sha);

// GitHub as far as promote.js asks it
const hub = {
  prs_: [], checks: new Map(), reviews: [],
  view(p) { return { ...p, headOid: p.state === 'OPEN' ? tip('refs/heads/' + p.head) : p.headOid }; },
  pr(n) { return this.view(this.prs_[n - 1]); },
  prs({ base }) { return this.prs_.filter((p) => p.state === 'OPEN' && p.base === base).map((p) => this.view(p)); },
  createPr({ base, head, title, body, author = 'dreetje-echo[bot]' }) {
    this.prs_.push({ number: this.prs_.length + 1, base, head, title, body, author, state: 'OPEN', isDraft: false, isCrossRepository: false });
    return this.prs_.length;
  },
  check(sha, name) { return this.checks.get(name + ':' + sha) || null; },
  pass(sha, name = 'gate', conclusion = 'success') { this.checks.set(name + ':' + sha, { status: 'completed', conclusion }); },
  approve(n, sha, user = 'andre') { this.reviews.push({ n, sha, user }); },
  approvedAt(n, sha) { const author = this.prs_[n - 1].author; return this.reviews.filter((r) => r.n === n && r.sha === sha && r.user !== author).map((r) => r.user); },
  merge(n, sha) {
    const p = this.prs_[n - 1];
    const head = tip('refs/heads/' + p.head);
    if (head !== sha) throw new Error('Head branch was modified');
    const base = tip('refs/heads/' + p.base);
    const t = g(origin, 'merge-tree', '--write-tree', base, head).split('\n')[0];
    const m = g(origin, 'commit-tree', t, '-p', base, '-p', head, '-m', 'Merge pull request #' + n + ' from o/' + p.head);
    setRef('refs/heads/' + p.base, m);
    Object.assign(p, { state: 'MERGED', headOid: head });
  },
};

const p = make({ cwd: tool, hub, identity: {}, trailer: '', today: () => '2026-10-04', push: (sha, ref) => g(tool, 'push', '-q', 'origin', sha + ':' + ref) });
const fails = (fn, re) => assert.throws(fn, re);
const problems = (n) => p.check({ pr: n }).problems.join(' | ');
const LANE = 'integration/andre';

// only a developer's lane on origin can be frozen
fails(() => p.start({ lane: 'integration/codex' }), /not a developer/);
fails(() => p.start({ lane: 'integration/maria' }), /not on origin/);
fails(() => p.start({ lane: LANE }), /holds nothing main does not/);

// work in the lane, and an ordinary change landed on main meanwhile
const f1 = land(LANE, 'f1.txt', '1');
const m1 = land('main', 'm1.txt', '1');

// freezing: the lane's tip, main merged in, the bump on top, and the freeze in the description
const dry = p.start({ lane: LANE, bump: 'minor', dryRun: true });
assert.equal(dry.branch, 'batch/andre-2026-10-04-' + short(f1));
assert.equal(MARK.exec(dry.body)[2], f1);
assert.equal(g(origin, 'ls-remote', '.', 'refs/heads/' + dry.branch), '', 'a dry run pushes nothing');
const s = p.start({ lane: LANE, bump: 'minor' });
assert.equal(s.pr, 1);
const batch = s.branch;
let head = tip('refs/heads/' + batch);
assert.ok(holds(head, f1) && holds(head, m1), 'the batch holds the frozen lane and main');
assert.equal(JSON.parse(g(origin, 'show', head + ':package.json')).version, '1.1.0');
const lock = JSON.parse(g(origin, 'show', head + ':package-lock.json'));
assert.deepEqual([lock.version, lock.packages[''].version], ['1.1.0', '1.1.0']);
assert.deepEqual(g(origin, 'diff-tree', '--no-commit-id', '--name-only', '-r', head).split('\n').sort(), ['package-lock.json', 'package.json'], 'the bump changes the version and nothing else');
fails(() => p.start({ lane: LANE }), /already has batch #1/);

// the lane goes on during the freeze, and the batch does not
const f2 = land(LANE, 'f2.txt', '2');
assert.equal(tip('refs/heads/' + batch), head);
assert.ok(!holds(head, f2));

// may it merge? Not without the gate passing on this exact head, and the combined review approving it
assert.match(problems(1), /gate has not run on/);
hub.pass(head, 'gate', 'failure');
assert.match(problems(1), /gate on \w+ ended failure/);
hub.pass(head, 'gate', 'skipped');
assert.match(problems(1), /ended skipped/, 'a skipped gate is no pass');
hub.pass(head);
assert.match(problems(1), /approved/);
hub.approve(1, f1);
hub.approve(1, head, 'dreetje-echo[bot]');
assert.match(problems(1), /approved/, 'an approval of an older commit, or by the author, is none');
hub.approve(1, head);
assert.equal(problems(1), '');

// what may not join a frozen batch: the lane's later work merged in, or a change of its own
g(dev, 'fetch', '-q', 'origin');
g(dev, 'checkout', '-q', '-B', 'sneak', head);
g(dev, 'merge', '-q', '--no-edit', 'origin/' + LANE);
g(dev, 'push', '-q', '-f', 'origin', 'HEAD:refs/heads/' + batch);
hub.pass(tip('refs/heads/' + batch)); hub.approve(1, tip('refs/heads/' + batch));
assert.match(problems(1), /merges in commits that are neither the frozen lane nor main/);
setRef('refs/heads/' + batch, head);
land(batch, 'a.txt', 'changed');
hub.pass(tip('refs/heads/' + batch)); hub.approve(1, tip('refs/heads/' + batch));
assert.match(problems(1), /changes a\.txt after the freeze/);
setRef('refs/heads/' + batch, head);
// a description edited to another freeze
hub.prs_[0].body = hub.prs_[0].body.replace(f1, f2);
assert.match(problems(1), /not the one the branch/);
hub.prs_[0].body = hub.prs_[0].body.replace(f2, f1);

// a hotfix lands on main during the freeze: the batch is behind, and merging is refused with main left alone
const m2 = land('main', 'm2.txt', 'hotfix');
assert.match(problems(1), /main has moved/);
fails(() => p.merge({ pr: 1 }), /may not merge/);
assert.equal(tip('refs/heads/main'), m2);
// refresh brings main in, not the lane; the gate and the review start again on the new head
const r = p.refresh({ pr: 1 });
head = tip('refs/heads/' + batch);
assert.equal(r.head, head);
assert.ok(holds(head, m2) && !holds(head, f2));
assert.match(problems(1), /gate has not run on/);
hub.pass(head); hub.approve(1, head);
assert.equal(problems(1), '');

// GitHub refuses a head that moved after the check
const real = hub.merge.bind(hub);
hub.merge = (n) => real(n, 'f'.repeat(40));
fails(() => p.merge({ pr: 1 }), /Head branch was modified/);
hub.merge = real;
assert.equal(tip('refs/heads/main'), m2);

// merged: main is the tested tree, holds every frozen commit and the hotfix, and not the lane's later work
const merged = p.merge({ pr: 1 });
const main = tip('refs/heads/main');
assert.equal(merged.merged, main);
assert.equal(tip(main + '^{tree}'), tip(head + '^{tree}'));
for (const c of [f1, m1, m2]) assert.ok(holds(main, c), short(c));
assert.ok(!holds(main, f2));

// tagged only as the tested merge; once
assert.equal(p.tag({}).tag, 'v1.1.0');
assert.equal(tip('refs/tags/v1.1.0^{commit}'), main);
assert.equal(p.verifyTag({ tag: 'v1.1.0' }).ok, true);
fails(() => p.tag({}), /v1\.1\.0 is already/);

// main back into the lane, by a pull request merged with a merge commit: the lane keeps f2, nothing is dropped
const sy = p.sync({ lane: LANE });
const syncPr = sy.pr;
assert.equal(hub.prs_[syncPr - 1].base, LANE);
assert.match(problems(syncPr), /ready has not run/);
land(sy.branch, 'stray.txt', 'x');
hub.pass(tip('refs/heads/' + sy.branch), 'ready');
assert.match(problems(syncPr), /a sync brings main and nothing else/);
setRef('refs/heads/' + sy.branch, main);
hub.pass(main, 'ready');
p.merge({ pr: syncPr });
const laneTip = tip('refs/heads/' + LANE);
assert.ok(holds(laneTip, main) && holds(laneTip, f2));
assert.equal(p.sync({ lane: LANE }).already, true);
const st = p.status({ lane: LANE }).lanes[0];
assert.equal(st.hasMain, true);
assert.ok(st.ahead >= 1);

// an ordinary pull request into main: the gate on its head, no lane, no batch review
const feat = land('codex/feat', 'g.txt', 'g');
const n = hub.createPr({ base: 'main', head: 'codex/feat', author: 'dreetje-echo[bot]' });
assert.match(problems(n), /gate has not run/);
hub.pass(feat);
assert.equal(problems(n), '');
p.merge({ pr: n });
fails(() => p.tag({}), /v1\.1\.0 is already/, 'a release needs a bump');
// the bump goes through the gate like any change, then main is tagged
const b = p.bump({ kind: 'patch' });
assert.equal(b.branch, 'release/v1.1.1');
fails(() => p.merge({ pr: b.pr }), /gate has not run/);
hub.pass(b.head);
p.merge({ pr: b.pr });
assert.equal(p.tag({}).tag, 'v1.1.1');

// main that is not a tested merge: a commit pushed past the rules, and a merge of a head that was behind main
const pushed = land('main', 'direct.txt', 'd');
assert.match(p.tested('origin/main').problems.join(' '), /not the merge of a pull request/);
fails(() => p.tag({}), /main is not tagged/);
g(tool, 'tag', 'v9.9.9', pushed); g(tool, 'push', '-q', 'origin', 'refs/tags/v9.9.9');
assert.equal(p.verifyTag({ tag: 'v9.9.9' }).ok, false);
const old = land('codex/old', 'h.txt', 'h', 'main');
setRef('refs/heads/codex/old', old);
land('main', 'i.txt', 'i');
hub.pass(old);
const behind = tip('refs/heads/main');
const t = g(origin, 'merge-tree', '--write-tree', behind, old).split('\n')[0];
setRef('refs/heads/main', g(origin, 'commit-tree', t, '-p', behind, '-p', old, '-m', 'merged while behind'));
assert.match(p.tested('origin/main').problems.join(' '), /is not the tree of/, 'a head behind main was not the tree main got');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('promote ok');
