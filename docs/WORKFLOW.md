# How a change reaches main, and a release

Main only holds what passed the full gate as it is: the desktop's lint, checks and user flows, the Android app and the
iPhone UI tests, run by GitHub on the exact commit whose tree main gets. A release is made from main and nothing else.
This page says how that holds, what enforces each part, and what is still a proposal (Activation, below). The
orbital-workflow skill (`.agents/skills/orbital-workflow/SKILL.md`) is the same as steps for an agent.

## Where a pull request goes

The base of a pull request, and nothing about its head, decides what GitHub runs. There is no mode to switch.

| State, base | What runs | Required check |
|---|---|---|
| Draft, any base | the secrets scan (`ci.yml`) and nothing else: every other job is skipped, and no skipped job is named `gate`, `ready` or `platforms`: their names are expressions, which GitHub shows unevaluated on a skipped job | none: a draft cannot merge |
| Ready, into **main** (the default) | the full gate, `checks.yml`: lint, `npm run check` and `npm run flows`; Android's tests, lint and debug build; the iPhone UI tests on a simulator. On the head commit itself, which must contain main as it is | `gate`, `secrets`, `platforms` |
| Ready, into **integration/<developer>** | the cheap checks, `ready.yml`: lint and `npm run check`, and the flows when the desktop's pages changed, on GitHub's merge of the head into the lane | `ready`, `secrets`, `platforms` |
| Ready, into anything else (a stack layer) | the full gate, as into main | none: it reaches main through the gate anyway |

The two workflows split on the base (`branches-ignore` and `branches: ['integration/**']`) and `scripts/gate.js route`
checks it again: `integration/codex`, `integration/a/b` or a capital letter is no lane, and its pull request fails rather
than getting the cheap checks. A head behind main still runs every job, and `gate` fails until main is merged in.

`gh pr ready` (the `ready_for_review` event) starts the checks afresh on the head as it is. `gh pr ready --undo` (the
`converted_to_draft` event) stops them: the new run skips everything, and it cancels the run in progress, whose verdict
then reads cancelled, never passed. Each job but the secrets scan says `if: github.event.pull_request.draft != true`;
the verdict says `always() && github.event.pull_request.draft != true`, so on a ready pull request or by hand it runs
whatever happened before it, cancellation included.

Most work goes straight into main, one pull request at a time: slow, a quarter of an hour of runners each, and safe.
A lane is for a burst of related work that would otherwise wait on that gate once per pull request.

## Lanes

A lane is `integration/<developer>`: one person's, made from main when they start a burst of work and with their
say-so, shared by the agents working for them. An agent's own branch (`codex/…`, `claude/…`) is never a lane, and
`gate.js lane` refuses those names. No lane exists until someone makes one:

```sh
git push origin origin/main:refs/heads/integration/andre    # by the lane's owner, or with their say-so
```

During the burst, each change is its own pull request into the lane (`gh pr create --draft --base integration/andre`),
tested here as any other, made ready, given its cheap checks and a focused review of its own diff, and merged into the
lane. Dependent changes are a stack whose trunk is the lane (the gh-stack skill).

When the lane should reach main:

1. `node scripts/promote.js start --lane integration/andre [--bump minor]` freezes the lane at its tip as
   `batch/andre-<date>-<sha>`. When main moved since the lane last had it, main is merged in (a conflict stops it: sync
   first, below); with `--bump`, the version bump is the batch's last commit. It opens the batch into main, with the
   frozen commit in its description. Whatever merges into the lane from now on stays out of this batch.
2. The full gate runs on the batch's head. Someone other than its author reviews the batch as a whole
   (`main...batch/…`: how the changes meet, what the separate reviews could not see) and approves that head. The
   batch is opened by dreetje-echo[bot], so Andre can approve it.
3. When main moves meanwhile (a hotfix, an ordinary pull request), the batch is behind and its gate fails.
   `node scripts/promote.js refresh --pr <n>` merges main, and only main, into the batch; the gate and the approval
   start again on the new head.
4. `node scripts/promote.js merge --pr <n>` merges it, only if `check` passes: the head contains main; the gate passed
   on that exact head; the frozen commit is in it; nothing joined it after the freeze but main and the version bump; and
   someone other than its author approved that exact head. GitHub then merges only if the head is still that commit
   (`--match-head-commit`), and the tool reads main back: a merge commit whose second parent is the tested head, with
   its tree.
5. `node scripts/promote.js sync --lane integration/andre` opens main into the lane as a pull request (`sync/andre-…`),
   merged with `promote merge` once `ready` passes: a merge commit, so the lane keeps every commit it had. A shared lane
   is never rebased or force-pushed. A conflict is resolved on the sync branch.

`node scripts/promote.js status` shows every lane: how far ahead of main, whether it holds main, its open batch, and
how much merged into it since the freeze. When a burst is over and the lane is in main, its owner deletes it.

## Ordinary pull requests, hotfixes and infrastructure

There is no exception for them: into main, through the full gate. A hotfix during a frozen batch lands first, and the
batch is refreshed (step 3). Build, release and workflow changes are ordinary pull requests into main, and a lane gets
them by sync. `node scripts/promote.js check --pr <n>` and `merge --pr <n>` work for any pull request into main: the
gate on the exact head and the head containing main. Their review is the focused review of their own diff.

## How the tested commit is the one main gets

- `checks.yml` checks out `pull_request.head.sha`, not GitHub's merge ref, and `gate.js route` fails the gate unless
  that head contains main as fetched when the run started. A head containing main merges into main with exactly its
  own tree: the three-way merge's base is main itself.
- Its verdict job `gate` runs on every ready pull request and by hand, and fails on a refused route, a head behind main,
  and any job skipped, cancelled or failed. GitHub counts a skipped job as passed, so a required check skipped under its
  own name would pass a pull request whose tests never ran: a draft made ready while a fork's first run waits for
  approval, say. On a draft the verdict is skipped, and so its name is an expression that reads `gate` only
  when it runs: GitHub shows it unevaluated on a skipped job (#742's draft showed
  `github.event.pull_request.draft && 'gate (not run on drafts)' || 'gate'`), so no skipped check named `gate`,
  `ready` or `platforms` is ever left on a head.
- Pull requests from forks run the same workflows, as `pull_request`: a read-only token, no secrets, nothing written,
  and each checkout keeps no token in `.git/config`. No workflow uses `pull_request_target` or `workflow_run`, which run
  with the repository's own token beside the pull request's code. First-time contributors' runs wait for approval
  (the repository's setting).
- `scripts/workflow-check.js` (in `npm run check`) fails on any workflow that breaks these: a privileged trigger, a
  written permission or a secret in a pull request's workflow, an event value pasted into a script, a checkout keeping
  its credentials, a required check that can be skipped, a verdict that does not need every job, a paths filter.
- A pull request edits its own workflows, and they run as it wrote them: a required check proves nothing about a pull
  request that rewrites the check. Review is the defence: CODEOWNERS names Andre for `.github/` and the scripts behind
  the gate, which the proposed ruleset makes him approve.

## What enforces what

| Rule | Today | Once activated |
|---|---|---|
| Nothing reaches main but by a pull request, no force push, no deletion | the ruleset "Protect default branch" | the same |
| The full gate passed on the exact head | `promote merge` only | GitHub: required check `gate` from GitHub Actions |
| The head contains main | the gate's verdict and `promote merge` | GitHub too: strict required checks |
| A merge commit, so tested commits stay reachable | `promote merge` only (merge, squash and rebase are allowed) | GitHub: merge commits only |
| The head merged is the head that passed | `promote merge` (`--match-head-commit`) | the same; strict checks keep a moved head pending |
| Workflow and gate changes reviewed by Andre | nothing | GitHub: code owner review (verify on a test pull request after activation) |
| A batch frozen, its combined review approving its head | `promote check` and `merge` only | the same; GitHub enforces it only if main requires an approval (below) |
| A lane's cheap checks | nothing (there is no lane) | GitHub: required check `ready` on `integration/**` |
| A release is a tested merge | `npm run release`: `promote tag` and `verify-tag` before it builds, from the tag | the same (it runs on this Mac, where the keys are) |

Nothing here is enforced by GitHub until the rulesets below are applied and read back.

## Releasing

A release is main after everything in it is green: merged, then tagged, then built.

1. The version bump goes through the gate like any change: `node scripts/promote.js bump patch` opens
   `release/v<x>` into main, or `start --bump` puts it in a lane's batch. The bump is `package.json` and the lock;
   Android reads its version from `package.json` (#740).
2. Once it is merged, `node scripts/promote.js tag` tags main's tip `v<version>`, only when that tip is the merge of a
   head whose gate passed, with that head's tree, and only once per version.
3. The builds are made from the tag, on this Mac, where the keys are: the Mac app signed with the Developer ID and
   notarized (Keychain), and the Android APK signed with Orbital's release key (#740). They are attached to the
   tag's GitHub release. `npm run release` does steps 2 and 3: it tags main (or takes the version's tag), checks the
   tag with `node scripts/promote.js verify-tag`, checks the commit out with `node_modules` that match it, builds,
   checks it is still on that commit, and publishes on that tag (`gh release create --verify-tag`).
4. Nothing is announced (release notes, the manual on orbital.md, #orbital) until every build the release carries is
   made and read back. A build that fails leaves the tag and no release: it is fixed by a new change and a new version
   through the gate, never by building something other than the tag.

The gate already builds what CI can without keys: the Android debug build and the iPhone app for the simulator. The
iPhone's TestFlight beta is uploaded by hand from Xcode and is not part of this flow; nothing here uploads to the App
Store or Google Play (each needs its own credentials, and docs/ANDROID.md has Play's).

Before this, `scripts/release.sh` bumped the version itself and merged its bump's pull request at once, so what it built
had passed no gate. It now takes no version and makes no commit; `scripts/release-check.js` runs it on stubs and fails
if it bumps, merges or pushes a branch, tags before every credential is checked, builds from a tag `promote.js` does not
pass, builds anything but the tagged commit, or publishes on any other tag. It builds on #740's script (the Android
APK, its key checked with the Mac's credentials, the mirror getting the zip alone), so this pull request merges after
#740.

A release needs a `gate` check on the head main merged, and only this pull request's `checks.yml` makes one: the first
release after it lands is the first version bump merged through the gate.

## Activation

Each step changes the repository's settings or branches and needs Andre's approval when it is taken. This pull request
changes none of them.

1. **Merge #740 first.** This pull request contains #740 as published at e452d43 (merged in, not rebased) and
   builds its `release.sh` on it; once #740 lands, main is merged in here and the diff is this change alone. If #740
   changes again before it lands, this branch merges its new head and runs the release checks again.
2. **Merge this pull request**, ready and with its full gate green: it is the first pull request the new `checks.yml`
   gates.
3. **Give dreetje-echo the Workflows permission** (read and write) if agents are to push changes to
   `.github/workflows/`: GitHub refuses those pushes from an App without it. Otherwise such changes are pushed by Andre.
4. **Update main's ruleset** (id 23756367, "Protect default branch") to this, then read it back
   (`gh api repos/foeken/orbital/rulesets/23756367`) and open a test pull request to see `gate` required and a draft
   blocked:

   ```json
   {
     "name": "Protect default branch",
     "target": "branch",
     "enforcement": "active",
     "bypass_actors": [],
     "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
     "rules": [
       { "type": "deletion" },
       { "type": "non_fast_forward" },
       { "type": "pull_request", "parameters": {
         "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": true, "required_reviewers": [],
         "require_code_owner_review": true, "require_last_push_approval": false,
         "required_review_thread_resolution": false, "allowed_merge_methods": ["merge"] } },
       { "type": "required_status_checks", "parameters": {
         "strict_required_status_checks_policy": true, "do_not_enforce_on_create": false,
         "required_status_checks": [
           { "context": "gate", "integration_id": 15368 },
           { "context": "secrets", "integration_id": 15368 },
           { "context": "platforms", "integration_id": 15368 } ] } }
     ]
   }
   ```

   `integration_id` 15368 is GitHub Actions: a status of the same name set by anyone else does not count. The pull
   request rule keeps today's zero approvals. With `required_approving_review_count: 1` instead, GitHub itself would
   enforce the combined review on a batch (and an approval on every pull request into main, which a pull request Andre
   opened himself could not get from him). Turning on "Always suggest updating pull request branches"
   (`allow_update_branch`) gives a behind pull request an Update branch button that merges main in.
5. **When the first lane is made**, a ruleset for `refs/heads/integration/**`: no force push; pull requests only,
   merged with a merge commit or squashed; required `ready`, `secrets` and `platforms` from 15368, not strict. With no
   deletion rule, so a finished lane can be deleted.

## The pull requests open when this lands

- **#740** (Android release, draft, into main) stays into main and lands first (Activation, step 1).
- **#15** (Automations, Andre's draft since 2026-09) stays into main and gets the gate once it is ready. A pull request
  opened before this lands runs the new workflows on its next push, since a pull request runs the workflows of its
  merge with main.
- Nothing is retargeted: there is no lane yet, and moving a pull request into one is its author's choice.
