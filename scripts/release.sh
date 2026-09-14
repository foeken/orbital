#!/bin/sh
# Cut a release: bump the version, build the arm64 bundle, zip it, publish it to GitHub.
# The app's updater (updater.js) reads the newest release of the same repo through the gh CLI.
# Usage: npm run release [patch|minor|major|<version>]
set -e
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain)" ] || { echo "working tree is dirty; commit first"; exit 1; }
npm version "${1:-patch}"
version=$(node -p "require('./package.json').version")
npm run package
zip="dist/Tana-Companion-$version-arm64.zip"
rm -f "$zip"
ditto -c -k --keepParent "dist/Tana Companion-darwin-arm64/Tana Companion.app" "$zip"
git push --follow-tags
gh release create "v$version" "$zip" --title "v$version" --generate-notes
echo "released v$version"
