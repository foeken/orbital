#!/bin/sh
# Release tested main: build the Mac app and the Android APK from main's version tag, and publish them to GitHub.
# A release is the commit the full gate passed and nothing else (docs/WORKFLOW.md, Releasing): the version bump went
# through the gate first, as a pull request (node scripts/promote.js bump patch, or start --bump on a lane's batch), and
# here main's tip is tagged v<version> only when it is the merge of a head whose gate passed, with that head's tree
# (scripts/promote.js tag), or the tag is already there; scripts/promote.js verify-tag says so before anything is built,
# and everything is built from that commit, checked out. Nothing here bumps, commits, merges or pushes a branch.
# The zip is published as a release of this repo, where the app's updater (updater.js) reads it over the plain GitHub
# API, with no token and no gh CLI. Copies up to 0.9.1 read foeken/orbital-releases instead, so each release is
# mirrored there too: an old copy finds it there, installs it as any update, and reads this repo from then on. Once
# the mirror's download counts show no older copy is left, set ORBITAL_MIRROR_REPO= (empty) and archive that repo: an
# archived repo still serves its releases, so its last one keeps moving a copy that turns up later.
# The Android app goes beside the zip as Orbital-android.apk, at the same version, signed with Orbital's own release key
# (scripts/android-release.sh, docs/ANDROID.md Releasing): the Help tour's code downloads it from the latest release.
# ORBITAL_ANDROID=0 releases the Mac alone, and the tour says Android is coming soon for as long as the latest has none.
# Signing and notarization reuse the setup Meeting Notes uses (see ~/Code/meeting-notes/RELEASING.md):
# the Developer ID certificate and the notarytool credentials stay in the Keychain and never enter the repo.
# Usage: [ORBITAL_ANDROID=0] npm run release
set -e
cd "$(dirname "$0")/.."
[ $# -eq 0 ] || { echo "release takes no version: the bump goes into main through the gate first (node scripts/promote.js bump patch; docs/WORKFLOW.md, Releasing)"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "working tree is dirty; commit first"; exit 1; }

# Every credential is checked before main is tagged: a tag is public at once. `store-credentials` created the profile;
# `history` is the cheapest proof that it still authenticates. The Android key must open and be the pinned one, and
# never a debug key.
profile="${ORBITAL_NOTARY_PROFILE:-notarytool}"
releases=${ORBITAL_RELEASES_REPO:-foeken/orbital}
mirror=${ORBITAL_MIRROR_REPO-foeken/orbital-releases}
android=${ORBITAL_ANDROID:-1}
security find-identity -v -p codesigning | grep -q 'Developer ID Application' \
  || { echo "no Developer ID Application identity in the keychain"; exit 1; }
xcrun notarytool history --keychain-profile "$profile" >/dev/null \
  || { echo "notarytool profile '$profile' cannot authenticate; create it with: xcrun notarytool store-credentials"; exit 1; }
[ "$android" = 0 ] || sh scripts/android-release.sh --check

# main's version, tagged on its tested tip unless that version is tagged already, and the tag held to the same rule
git fetch -q --tags origin
version=$(git show origin/main:package.json | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version")
tag="v$version"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null || node scripts/promote.js tag
node scripts/promote.js verify-tag "$tag" >/dev/null || { node scripts/promote.js verify-tag "$tag"; echo "$tag is not a commit the gate passed: nothing is built"; exit 1; }
commit=$(git rev-parse "$tag^{commit}")

# built from the tag itself, and back where it started afterwards, whatever happens
back=$(git symbolic-ref -q --short HEAD || git rev-parse HEAD)
trap 'git switch -q "$back"' EXIT
git switch -q --detach "$commit"
# the packager copies node_modules as they are: they must be what the tag's package.json asks for
npm ls --omit=dev >/dev/null || { echo "node_modules do not match $tag's package.json: npm install, then release again"; exit 1; }

# @electron/osx-sign signs the helpers inside-out with the hardened runtime and Electron's entitlements, and
# @electron/notarize submits, waits and staples the ticket into the bundle. Both already ship with the packager.
npm run package -- --osx-sign --osx-notarize.keychainProfile="$profile"
app="dist/Orbital-darwin-arm64/Orbital.app"
xcrun stapler validate "$app"
spctl --assess --type execute -vv "$app" # what Gatekeeper will say on a stranger's Mac, before it is published
zip="dist/Orbital-$version-arm64.zip"
rm -f "$zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
# the APK of the same commit, signed and read back (version, key, not debuggable) before anything is published
apk=""
if [ "$android" != 0 ]; then apk="dist/Orbital-android.apk"; rm -f "$apk"; sh scripts/android-release.sh "$apk"; fi
# still the tagged commit, with nothing beside it that the build could have picked up
[ "$(git rev-parse HEAD)" = "$commit" ] && [ -z "$(git status --porcelain)" ] \
  || { echo "the checkout moved away from $tag during the build: nothing is published"; exit 1; }

# One opening line for a download by hand, which the update card leaves out (updater.js notes)
notes="Orbital $version for Apple Silicon. Signed and notarized; unzip and move it to Applications."
set -- "$zip"
[ -z "$apk" ] || set -- "$@" "$apk"
# --verify-tag: on the tag promote.js pushed, never a new one gh would make on whatever main is now
gh release create "$tag" "$@" --repo "$releases" --title "$tag" --verify-tag \
  --notes "$notes${apk:+ For Android 10 or later: open Orbital-android.apk on the phone and allow your browser to install it when Android asks.}"
# the mirror is for old Mac copies only: the zip, and no APK
[ -z "$mirror" ] || gh release create "$tag" "$zip" --repo "$mirror" --title "$tag" --notes "$notes"
echo "released $tag${apk:+ with Android} to $releases${mirror:+ and $mirror}, built from $commit"
# Slack has no token here: the agent cutting the release posts the notes with its Slack connector.
echo "next: publish what npm run manual-diff -- $tag lists to https://orbital.md/manual (.agents/skills/orbital-manual/SKILL.md, Publishing), write the release notes (gh release edit $tag --repo $releases --notes-file …${mirror:+, and the same for --repo $mirror, whose copy old installs read}) and post them in #orbital on Slack (channel C0C5D5C07EH) with a link to https://github.com/$releases/releases/tag/$tag"
