#!/bin/sh
# npm run done: after this worktree's pull request has merged, its simulator, build output and the worktree itself gone.
# Refuses while anything here is not on main yet: uncommitted changes, commits not pushed, or a branch not merged.
set -e
cd "$(dirname "$0")/.."
here=$(pwd -P)
main=$(git rev-parse --path-format=absolute --git-common-dir | xargs dirname)
git fetch -q origin main
[ -z "$(git status --porcelain)" ] || { echo "done: uncommitted changes here; commit or drop them first"; exit 1; }
[ -z "$(git rev-list HEAD --not --remotes)" ] || { echo "done: commits here that are not pushed"; exit 1; }
git merge-base --is-ancestor HEAD origin/main || { echo "done: this branch is not merged into main yet"; exit 1; }
sh scripts/phones.sh clean
[ "$here" = "$(cd "$main" && pwd -P)" ] && { echo "done: the main checkout stays"; exit 0; }
cd "$main" && git worktree remove "$here" && echo "done: removed the worktree $here"
