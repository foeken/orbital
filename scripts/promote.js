#!/usr/bin/env node
'use strict';
// Getting a change into main tested, and keeping a developer's integration lane in step with it (AGENTS.md, Pull
// requests; docs/WORKFLOW.md; the orbital-workflow skill). Every command reads origin afresh first.
//
//   node scripts/promote.js check --pr <n>       read-only: may pull request <n> merge? (below)
//   node scripts/promote.js merge --pr <n>       check, then merge with a merge commit, only if the head is still the
//                                                commit that was checked, then read the base back
//   node scripts/promote.js refresh --pr <n>     main moved under a pull request into main: merge main into its branch
//                                                (never the lane), so the gate runs again on a head that contains it
//   node scripts/promote.js status [--lane integration/<developer>]
//   node scripts/promote.js start --lane integration/<developer> [--bump patch|minor|major] [--dry-run]
//                                                freeze the lane at its tip as batch/<developer>-<date>-<sha>, with main
//                                                merged in when it moved and the version bump on top, and open it into
//                                                main; work merged into the lane later stays out
//   node scripts/promote.js sync --lane integration/<developer> [--dry-run]
//                                                bring main into the lane by a pull request merged with a merge commit;
//                                                a shared lane is never rebased or force-pushed
//   node scripts/promote.js bump patch|minor|major [--dry-run]
//                                                the version bump as its own pull request into main (release/v<x>)
//   node scripts/promote.js tag [--dry-run]      tag main's tip v<package.json version>, only when it is the merge of a
//                                                head whose gate passed and has that head's tree
//   node scripts/promote.js verify-tag <tag>     read-only, for scripts/release.sh: the tag is on main and is such a merge
// scripts/promote-check.js runs every command on throwaway repositories (npm run check).
//
// A pull request into main may merge when: it is open and ready; its head contains main as it is now; and the gate
// (checks.yml's verdict job) passed on that exact head. A batch adds: its frozen lane commit is in the head, nothing
// joined it after the freeze but main and the version bump, and someone other than its author approved that exact head
// (the combined review). A sync into a lane: its ready check passed on its head, and it brings main and nothing else.
// Writes as dreetje-echo[bot] through echo-git when ORBITAL_AS_ECHO=1 (AGENTS.md), and otherwise as whoever runs it,
// with ORBITAL_TRAILER (a Co-authored-by line) added to the commits it makes.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lane: laneOf } = require('./gate.js');
const { AREAS } = require('./platform-check.js');

const VERSION_FILES = ['package.json', 'package-lock.json'];
const MARK = /<!-- orbital-batch lane=(\S+) freeze=([0-9a-f]{40}) -->/;
const short = (sha) => String(sha).slice(0, 7);

function bumped(version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error('package.json has no x.y.z version: ' + version);
  const [a, b, c] = m.slice(1).map(Number);
  if (kind === 'major') return (a + 1) + '.0.0';
  if (kind === 'minor') return a + '.' + (b + 1) + '.0';
  if (kind === 'patch') return a + '.' + b + '.' + (c + 1);
  throw new Error('bump patch, minor or major, not ' + kind);
}

// ctx: { cwd, hub, push(sha, ref), identity (env for the commits it makes), trailer, today() }
function make(ctx) {
  const run = (args, opts = {}) => execFileSync('git', args, { cwd: ctx.cwd, encoding: 'utf8', input: opts.input, env: { ...process.env, ...(opts.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const ok = (args) => { try { run(args); return true; } catch { return false; } };
  const rev = (r) => run(['rev-parse', '--verify', r + '^{commit}']);
  const has = (r) => ok(['rev-parse', '--verify', '--quiet', r + '^{commit}']);
  const contains = (tip, c) => ok(['merge-base', '--is-ancestor', c, tip]);
  const tree = (c) => run(['rev-parse', c + '^{tree}']);
  const parents = (c) => run(['rev-list', '--parents', '-n', '1', c]).split(' ').slice(1);
  const between = (tip, ...not) => run(['rev-list', tip, ...not.map((n) => '^' + n)]).split('\n').filter(Boolean);
  const changed = (c) => run(['diff-tree', '--no-commit-id', '--name-only', '-r', c]).split('\n').filter(Boolean);
  const fetch = () => run(['fetch', '--quiet', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*']);
  const version = (c) => JSON.parse(run(['show', c + ':package.json'])).version;
  const message = (m) => m + (ctx.trailer ? '\n\n' + ctx.trailer : '');
  const commitTree = (t, ps, msg) => run(['commit-tree', t, ...ps.flatMap((p) => ['-p', p]), '-m', message(msg)], { env: ctx.identity });

  // a merge of b into a, made without a checkout; null when they conflict
  function merge(a, b, msg) {
    let t;
    try { t = run(['merge-tree', '--write-tree', a, b]).split('\n')[0]; } catch { return null; }
    return commitTree(t, [a, b], msg);
  }

  // the version bump as a commit on base, made without a checkout: package.json and the lock's own two versions
  function bump(base, kind) {
    const to = bumped(version(base), kind);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-'));
    const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
    try {
      run(['read-tree', base], { env });
      for (const f of VERSION_FILES) {
        let json;
        try { json = JSON.parse(run(['show', base + ':' + f])); } catch { continue; }
        json.version = to;
        if (json.packages && json.packages['']) json.packages[''].version = to;
        const blob = run(['hash-object', '-w', '--stdin'], { input: JSON.stringify(json, null, 2) + '\n' });
        run(['update-index', '--cacheinfo', '100644,' + blob + ',' + f], { env });
      }
      return { to, sha: commitTree(run(['write-tree'], { env }), [base], 'v' + to) };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  function lane(name) {
    const l = laneOf(name);
    if (!l.ok) throw new Error(l.reason);
    if (!has('origin/' + name)) throw new Error(name + ' is not on origin: a lane is made from main when a burst of work starts (docs/WORKFLOW.md, Lanes), with its owner\'s say-so');
    return l.developer;
  }

  // the Platforms lines a pull request of many changes carries: updated where its diff touches, otherwise why not
  function platforms(from, to) {
    const files = run(['diff', '--name-only', from + '...' + to]).split('\n').filter(Boolean);
    return '## Platforms\n' + Object.entries(AREAS).map(([area, test]) => '- **' + area + '**: ' +
      (files.some(test) ? 'updated' : 'not needed: nothing of it in these changes')).join('\n');
  }

  function prsIn(from, to) {
    const out = [];
    for (const s of run(['log', '--first-parent', '--format=%s', to, '^' + from]).split('\n')) {
      const m = /#(\d+)/.exec(s);
      if (m) out.push('- #' + m[1] + ' ' + s.replace(/^Merge pull request #\d+ from \S+\s*/, ''));
    }
    return out;
  }

  const gateOn = (sha, name = 'gate') => {
    const c = ctx.hub.check(sha, name);
    if (!c) return { ok: false, says: name + ' has not run on ' + short(sha) };
    if (c.status !== 'completed') return { ok: false, says: name + ' on ' + short(sha) + ' is ' + c.status };
    if (c.conclusion !== 'success') return { ok: false, says: name + ' on ' + short(sha) + ' ended ' + c.conclusion };
    return { ok: true, says: name + ' passed on ' + short(sha) };
  };

  function check({ pr }) {
    fetch();
    const p = ctx.hub.pr(pr);
    const problems = [];
    const head = p.headOid;
    if (p.state !== 'OPEN') problems.push('#' + pr + ' is ' + p.state);
    if (p.isDraft) problems.push('#' + pr + ' is a draft');
    if (!has(head)) run(['fetch', '--quiet', 'origin', 'refs/pull/' + pr + '/head']);
    const result = { pr, head, base: p.base, problems, kind: 'change', approvals: [] };
    if (p.base !== 'main') {
      // a sync of main into a lane
      if (!/^sync\//.test(p.head) || !laneOf(p.base).ok || p.isCrossRepository) { problems.push('#' + pr + ' goes into ' + p.base + ': promote merges pull requests into main, and syncs of main into a lane'); return result; }
      result.kind = 'sync';
      const g = gateOn(head, 'ready');
      if (!g.ok) problems.push(g.says);
      for (const c of between(head, 'origin/main', 'origin/' + p.base)) {
        if (parents(c).length < 2) problems.push(short(c) + ' is neither main nor a merge resolving it: a sync brings main and nothing else');
      }
      return result;
    }
    const main = rev('origin/main');
    if (!contains(head, main)) problems.push('main has moved to ' + short(main) + ' since ' + short(head) + ': node scripts/promote.js refresh --pr ' + pr);
    const g = gateOn(head);
    if (!g.ok) problems.push(g.says);
    const mark = MARK.exec(p.body || '');
    if (/^batch\//.test(p.head) || mark) {
      result.kind = 'batch';
      if (p.isCrossRepository) problems.push('a batch is cut in this repository');
      if (!mark) problems.push('no freeze in the description: a batch is opened by promote start');
      else {
        const [, laneName, freeze] = mark;
        result.lane = laneName; result.freeze = freeze;
        if (!p.head.endsWith('-' + short(freeze))) problems.push('the description\'s freeze ' + short(freeze) + ' is not the one the branch ' + p.head + ' was cut at');
        if (!has(freeze) || !contains(head, freeze)) problems.push('the frozen ' + laneName + ' at ' + short(freeze) + ' is not in ' + short(head) + ': its commits would be dropped');
        else if (has('origin/' + laneName) && !contains('origin/' + laneName, freeze)) problems.push(short(freeze) + ' is not on ' + laneName);
        else {
          for (const c of between(head, freeze, main)) {
            const ps = parents(c);
            if (ps.length > 1) {
              if (!ps.slice(1).every((x) => contains(main, x))) problems.push(short(c) + ' merges in commits that are neither the frozen lane nor main');
            } else {
              const other = changed(c).filter((f) => !VERSION_FILES.includes(f));
              if (other.length) problems.push(short(c) + ' changes ' + other.join(', ') + ' after the freeze: only main and the version bump join a frozen batch');
            }
          }
        }
      }
      result.approvals = ctx.hub.approvedAt(pr, head);
      if (!result.approvals.length) problems.push('nobody but its author approved ' + short(head) + ': the combined review approves this exact commit');
    }
    return result;
  }

  // a commit and the head it merged, with the head's tree and a passed gate: { ok, problems, sha, tested, version }
  function tested(at) {
    const sha = rev(at);
    const problems = [];
    const ps = parents(sha);
    const head = ps[1];
    if (!contains('origin/main', sha)) problems.push(short(sha) + ' is not on main');
    if (ps.length !== 2) problems.push(short(sha) + ' is not the merge of a pull request: nothing was tested as it is');
    else {
      if (tree(sha) !== tree(head)) problems.push(short(sha) + ' is not the tree of ' + short(head) + ', the head it merged');
      const g = gateOn(head);
      if (!g.ok) problems.push(g.says);
    }
    return { ok: !problems.length, problems, sha, tested: head, version: version(sha) };
  }

  return {
    check,
    tested: (at) => { fetch(); return tested(at); },

    merge({ pr }) {
      const c = check({ pr });
      if (c.problems.length) throw new Error('#' + pr + ' may not merge:\n- ' + c.problems.join('\n- '));
      const before = rev('origin/' + c.base);
      ctx.hub.merge(pr, c.head);
      fetch();
      const after = rev('origin/' + c.base);
      const ps = parents(after);
      // what GitHub made: a merge commit of the checked head onto the base as it was
      if (ps.length !== 2 || ps[1] !== c.head) throw new Error(c.base + ' is at ' + short(after) + ', which is not a merge of ' + short(c.head) + ': look before anything else lands');
      if (!contains(after, before)) throw new Error(c.base + ' lost ' + short(before));
      if (c.base === 'main' && tree(after) !== tree(c.head)) throw new Error('main at ' + short(after) + ' is not the tree that passed the gate on ' + short(c.head));
      if (c.freeze && !contains(after, c.freeze)) throw new Error('main does not contain the frozen ' + short(c.freeze));
      return { ...c, merged: after, before };
    },

    refresh({ pr }) {
      fetch();
      const p = ctx.hub.pr(pr);
      if (p.base !== 'main' || p.state !== 'OPEN') throw new Error('refresh is for an open pull request into main');
      if (p.isCrossRepository) throw new Error('#' + pr + ' is a fork\'s: its author merges main in');
      const main = rev('origin/main');
      if (contains(p.headOid, main)) return { pr, head: p.headOid, already: true };
      const m = merge(p.headOid, main, 'Merge main into ' + p.head);
      if (!m) throw new Error('main and ' + p.head + ' conflict: merge origin/main into it in a worktree and resolve there');
      ctx.push(m, 'refs/heads/' + p.head);
      return { pr, head: m, main };
    },

    status({ lane: only } = {}) {
      fetch();
      const lanes = only ? [only] : run(['for-each-ref', '--format=%(refname:strip=2)', 'refs/remotes/origin/integration/']).split('\n').filter(Boolean);
      const main = rev('origin/main');
      const open = ctx.hub.prs({ base: 'main' });
      return { main, lanes: lanes.map((name) => {
        const l = laneOf(name);
        if (!l.ok || !has('origin/' + name)) return { name, problem: l.ok ? 'not on origin' : l.reason };
        const tip = rev('origin/' + name);
        const batch = open.find((p) => (MARK.exec(p.body || '') || [])[1] === name);
        const freeze = batch && MARK.exec(batch.body)[2];
        return { name, tip, hasMain: contains(tip, main), ahead: between(tip, main).length, prs: prsIn(main, tip),
          batch: batch && { pr: batch.number, head: batch.headOid, freeze, sinceFreeze: between(tip, freeze).length, gate: gateOn(batch.headOid).says } };
      }) };
    },

    start({ lane: name, bump: kind, dryRun }) {
      fetch();
      const developer = lane(name);
      const freeze = rev('origin/' + name);
      const main = rev('origin/main');
      if (contains(main, freeze)) throw new Error(name + ' holds nothing main does not');
      const open = ctx.hub.prs({ base: 'main' }).find((p) => (MARK.exec(p.body || '') || [])[1] === name);
      if (open) throw new Error(name + ' already has batch #' + open.number + ' open: merge or close it first');
      let head = freeze;
      if (!contains(freeze, main)) {
        head = merge(freeze, main, 'Merge main into the ' + name + ' batch');
        if (!head) throw new Error('main and ' + name + ' conflict: node scripts/promote.js sync --lane ' + name + ', resolve it there, then start');
      }
      let to = null;
      if (kind) ({ to, sha: head } = bump(head, kind));
      const branch = 'batch/' + developer + '-' + ctx.today() + '-' + short(freeze);
      const title = 'Batch from ' + name + ' at ' + short(freeze) + (to ? ', v' + to : '');
      const listed = prsIn(main, freeze);
      const body = ['<!-- orbital-batch lane=' + name + ' freeze=' + freeze + ' -->',
        name + ' frozen at ' + freeze + (head !== freeze ? ', with main merged in' : '') + (to ? ' and the version bumped to ' + to : '') + '. Work merged into the lane after this stays out (docs/WORKFLOW.md).',
        '', '**In this batch**', ...(listed.length ? listed : ['- (no pull request numbers in the lane\'s history)']),
        '', '**How it was checked**: the full gate (checks.yml) on this exact head, and the combined review: someone other than the author reads main...' + branch + ' as a whole and approves this head. node scripts/promote.js merge --pr <n> merges it only then.',
        '', platforms('origin/main', head)].join('\n');
      if (dryRun) return { branch, freeze, head, to, title, body };
      ctx.push(head, 'refs/heads/' + branch);
      const pr = ctx.hub.createPr({ base: 'main', head: branch, title, body });
      return { branch, freeze, head, to, pr };
    },

    sync({ lane: name, dryRun }) {
      fetch();
      const developer = lane(name);
      const main = rev('origin/main');
      if (contains('origin/' + name, main)) return { lane: name, already: true };
      const open = ctx.hub.prs({ base: name }).find((p) => /^sync\//.test(p.head));
      if (open) return { lane: name, pr: open.number, open: true };
      const branch = 'sync/' + developer + '-' + short(main);
      const body = ['Main at ' + main + ' into ' + name + ', merged with a merge commit (node scripts/promote.js merge --pr <n>): a shared lane is never rebased.', '', platforms('origin/' + name, main)].join('\n');
      if (dryRun) return { lane: name, branch, main, body };
      ctx.push(main, 'refs/heads/' + branch);
      const pr = ctx.hub.createPr({ base: name, head: branch, title: 'Sync main into ' + name + ' (' + short(main) + ')', body });
      return { lane: name, branch, main, pr };
    },

    bump({ kind, dryRun }) {
      fetch();
      const { to, sha } = bump(rev('origin/main'), kind);
      const branch = 'release/v' + to;
      const body = ['The version bump to ' + to + ', through the full gate like any change, so a release is tested main (docs/WORKFLOW.md, Releasing).', '', platforms('origin/main', sha).replace(/nothing of it in these changes/g, 'the version number only')].join('\n');
      if (dryRun) return { to, branch, head: sha, body };
      ctx.push(sha, 'refs/heads/' + branch);
      return { to, branch, head: sha, pr: ctx.hub.createPr({ base: 'main', head: branch, title: 'v' + to, body }) };
    },

    tag({ dryRun }) {
      fetch();
      const t = tested('origin/main');
      if (!t.ok) throw new Error('main is not tagged:\n- ' + t.problems.join('\n- '));
      const tag = 'v' + t.version;
      if (has('refs/tags/' + tag)) throw new Error(tag + ' is already ' + short(rev('refs/tags/' + tag)) + ': bump the version first (promote bump, or start --bump)');
      if (dryRun) return { tag, ...t };
      run(['tag', '-a', tag, t.sha, '-m', 'Orbital ' + t.version + ', main at ' + t.sha + ' (the gate passed on ' + t.tested + ')'], { env: ctx.identity });
      ctx.push('refs/tags/' + tag, 'refs/tags/' + tag);
      return { tag, ...t };
    },

    verifyTag({ tag }) {
      fetch();
      if (!has('refs/tags/' + tag)) return { ok: false, problems: ['no tag ' + tag] };
      const t = tested('refs/tags/' + tag);
      if ('v' + t.version !== tag) t.problems.push(tag + ' holds version ' + t.version);
      return { ...t, ok: !t.problems.length };
    },
  };
}

// GitHub through gh; writes through echo-git when ORBITAL_AS_ECHO=1
function ghHub(repo, asEcho) {
  const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (args) => execFileSync(asEcho ? 'echo-git' : 'gh', asEcho ? ['gh', ...args] : args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  const fields = 'number,state,isDraft,baseRefName,headRefName,headRefOid,body,isCrossRepository,url,author';
  const shape = (p) => ({ number: p.number, state: p.state, isDraft: p.isDraft, base: p.baseRefName, head: p.headRefName, headOid: p.headRefOid, body: p.body, isCrossRepository: p.isCrossRepository, url: p.url, author: p.author && p.author.login });
  return {
    pr: (n) => shape(JSON.parse(gh(['pr', 'view', String(n), '-R', repo, '--json', fields]))),
    prs: ({ base }) => JSON.parse(gh(['pr', 'list', '-R', repo, '--base', base, '--state', 'open', '--json', fields, '--limit', '100'])).map(shape),
    createPr({ base, head, title, body }) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-'));
      try {
        fs.writeFileSync(path.join(dir, 'body.md'), body);
        return write(['pr', 'create', '-R', repo, '--base', base, '--head', head, '--title', title, '--body-file', path.join(dir, 'body.md')]);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
    // the newest run of a check by GitHub Actions on a commit
    check(sha, name) {
      const runs = JSON.parse(gh(['api', 'repos/' + repo + '/commits/' + sha + '/check-runs?check_name=' + encodeURIComponent(name) + '&per_page=100'])).check_runs
        .filter((r) => r.app && r.app.slug === 'github-actions').sort((a, b) => b.id - a.id);
      return runs[0] ? { status: runs[0].status, conclusion: runs[0].conclusion, url: runs[0].html_url } : null;
    },
    // who, other than the author, approved exactly this commit and has not asked for changes since
    approvedAt(n, sha) {
      const author = JSON.parse(gh(['pr', 'view', String(n), '-R', repo, '--json', 'author'])).author.login;
      const reviews = gh(['api', '--paginate', 'repos/' + repo + '/pulls/' + n + '/reviews', '--jq', '.[] | {user: .user.login, state, commit_id}']).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const last = {};
      for (const r of reviews) if (r.state !== 'COMMENTED') last[r.user] = r;
      return Object.values(last).filter((r) => r.state === 'APPROVED' && r.commit_id === sha && r.user !== author).map((r) => r.user);
    },
    merge: (n, sha) => write(['pr', 'merge', String(n), '-R', repo, '--merge', '--match-head-commit', sha]),
  };
}

module.exports = { make, bumped, MARK };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const cmd = argv[0];
  const asEcho = process.env.ORBITAL_AS_ECHO === '1';
  const cwd = path.join(__dirname, '..');
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8' }).trim();
  const repo = (/github\.com[:/](.+?)(\.git)?$/.exec(url) || [])[1];
  const bot = 'dreetje-echo[bot]', mail = '328293375+dreetje-echo[bot]@users.noreply.github.com';
  const p = make({
    cwd, hub: ghHub(repo, asEcho), trailer: asEcho ? '' : process.env.ORBITAL_TRAILER || '',
    identity: asEcho ? { GIT_AUTHOR_NAME: bot, GIT_AUTHOR_EMAIL: mail, GIT_COMMITTER_NAME: bot, GIT_COMMITTER_EMAIL: mail } : {},
    today: () => new Date().toISOString().slice(0, 10),
    push: (sha, ref) => execFileSync(asEcho ? 'echo-git' : 'git', ['push', 'origin', sha + ':' + ref], { cwd, stdio: 'inherit' }),
  });
  const pr = Number(arg('--pr'));
  const show = (o) => console.log(JSON.stringify(o, null, 2));
  try {
    if (cmd === 'check') { const c = p.check({ pr }); show(c); process.exit(c.problems.length ? 1 : 0); }
    else if (cmd === 'merge') show(p.merge({ pr }));
    else if (cmd === 'refresh') show(p.refresh({ pr }));
    else if (cmd === 'status') show(p.status({ lane: arg('--lane') }));
    else if (cmd === 'start') show(p.start({ lane: arg('--lane'), bump: arg('--bump'), dryRun: argv.includes('--dry-run') }));
    else if (cmd === 'sync') show(p.sync({ lane: arg('--lane'), dryRun: argv.includes('--dry-run') }));
    else if (cmd === 'bump') show(p.bump({ kind: argv[1], dryRun: argv.includes('--dry-run') }));
    else if (cmd === 'tag') show(p.tag({ dryRun: argv.includes('--dry-run') }));
    else if (cmd === 'verify-tag') { const r = p.verifyTag({ tag: argv[1] }); show(r); process.exit(r.ok ? 0 : 1); }
    else { console.error('usage: see the top of scripts/promote.js'); process.exit(2); }
  } catch (e) { console.error('promote: ' + e.message); process.exit(1); }
}
