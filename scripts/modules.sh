#!/bin/sh
# node_modules for a worktree that has none, without a second 360 MB download of the same dependencies: clone the
# main checkout's tree. On APFS "cp -c" is copy-on-write, so what arrives is a real, independent directory (npm
# install in the worktree touches only its own copy) that costs about a third of a second and no disk.
# Run by npm before check, start and package, and by the main checkout's post-checkout hook when git itself makes a
# worktree - Codex makes its own without running hooks, which is why this also hangs off the scripts.
# Two silences: node_modules is already there, or there is nothing to clone (a fresh clone: npm install is the
# answer there, and the postinstall it needs cannot be skipped by copying anyway).
[ -e node_modules ] && exit 0
main=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" 2>/dev/null)
[ -n "$main" ] && [ -d "$main/node_modules" ] || exit 0
echo "modules: cloning $main/node_modules"
cp -Rc "$main/node_modules" node_modules 2>/dev/null || cp -R "$main/node_modules" node_modules # -c is APFS only
