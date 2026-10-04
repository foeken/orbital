---
name: orbital-workflow
description: How a change reaches Orbital's main and a release - drafts, where a pull request goes (main or a developer's integration/<developer> lane), the full gate and the cheap checks, freezing a lane into a batch, refreshing, merging, syncing main into a lane, hotfixes, stacks, version bumps and tags. Use when opening, readying, retargeting, reviewing or merging an Orbital pull request, when working in or promoting an integration lane, when main moves under an open pull request, and before tagging or releasing.
---

# Getting a change into Orbital's main

docs/WORKFLOW.md is the reference: the routing table, what enforces what, the rulesets and their activation. This is
the same as steps. The rule under all of it: **main only holds what passed the full gate as it is**, and a release is
made from main.

## Every change

1. Branch from where it goes: `origin/main` by default, or a lane (`origin/integration/<developer>`) when its owner
   is running one and this change belongs to it. Your branch is your own (`codex/<topic>`): rebase it as you like.
2. `gh pr create --draft --base <main or the lane>` (through `echo-git gh`, AGENTS.md). A draft runs only the secrets
   scan; every other check shows as "(not run on drafts)" until it is ready.
3. Test here what it touches (AGENTS.md, Pull requests): lint and check always, flows for the desktop's pages, phones
   for ios/, android/, ios/engine and sdk/. Review your own diff (`git diff origin/<base>...HEAD`), each data path end
   to end, and leave a check that fails on the old code.
4. Manual, Platforms lines, then `gh pr ready`: that starts the checks, into main the full gate (about a quarter of an
   hour), into a lane the cheap checks, and Platforms. Ask for review. Going back to draft (`gh pr ready --undo`)
   stops them.
5. Into main, merge with `node scripts/promote.js merge --pr <n>`, not the merge button and never a squash: it checks
   the gate passed on the exact head, merges only that head with a merge commit, and reads main back. Into a lane,
   `gh pr merge <n> --merge` once `ready` is green.
6. If main moved first, the gate says so: `node scripts/promote.js refresh --pr <n>` merges main in, and the gate runs
   again. A fork's pull request merges main in itself.

## A lane

Only a person's (`integration/andre`), made from main with their say-so: never create one on your own, never name one
after an agent, and never treat your own branch as one. `node scripts/promote.js status` lists them.

- Work into it as above, with `--base integration/<developer>`. Dependent changes are a stack whose trunk is the lane
  (the gh-stack skill); layers above the bottom get the full gate until they are retargeted onto the lane.
- To bring it to main: `node scripts/promote.js start --lane integration/<developer> [--bump patch|minor|major]`. It
  freezes the lane's tip as `batch/<developer>-<date>-<sha>`, merges main in when it moved, adds the bump, and opens the
  batch into main. Keep merging into the lane: none of it joins this batch. Never push to a batch branch yourself.
- The batch needs the full gate on its head and an approval of that exact head from someone other than its author,
  after a combined review: read `main...batch/…` as a whole, for how the changes meet. Post what you found on the pull
  request.
- Main moved during the freeze (a hotfix): `promote.js refresh --pr <n>`, then the gate and the approval again.
- `promote.js merge --pr <n>` refuses unless the frozen commit is in it, only main and the bump joined after the freeze,
  the gate passed on its head and the head was approved. Then `promote.js sync --lane <lane>` opens main into the lane;
  merge that with `promote.js merge --pr <n>` once `ready` is green. A lane is never rebased or force-pushed.

## Hotfixes, CI and release changes

An ordinary pull request into main, from main, through the full gate: no shortcut. A lane gets it through sync.

## Releasing

Only after everything in it is merged and green:

1. `node scripts/promote.js bump patch` (or `start --bump` for a batch) puts the bump through the gate; merge it.
2. `node scripts/promote.js tag` tags main, only if its tip is the merge of a head whose gate passed, with its tree.
3. `npm run release` (AGENTS.md, Releasing): no version. It tags tested main (step 2) if the version has no tag yet,
   holds the tag to the gate (`promote.js verify-tag`), and builds the Mac zip and the Android APK from that commit
   checked out. A failed build means a new change and a new version, never a build of something else.
4. Announce nothing until every build the release carries is made and read back.

## Stop and say so

- A permission refused (a push of `.github/workflows/` by the dreetje-echo App needs its Workflows permission), a
  ruleset or branch you would have to change, a lane that does not exist: report the exact target and reason. Do not
  switch identities, bypass a rule, or create a lane, ruleset or tag nobody asked for.
- The gate red on main's own tip, or `promote.js merge` saying main is not what it merged: nothing else lands until it
  is understood.
