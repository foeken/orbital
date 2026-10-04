#!/bin/sh
# Cut a release: bump the version, build the arm64 bundle, zip it, build the Android APK, publish both to GitHub.
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
# Usage: [ORBITAL_ANDROID=0] npm run release [patch|minor|major|<version>]
set -e
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain)" ] || { echo "working tree is dirty; commit first"; exit 1; }
# main is what a release ships: while its scheduled checks are failing ("Scheduled checks failed", checks.yml) there is
# no release, and its bump could not merge anyway (main-green.yml). Asked first, before anything is built or bumped.
gh issue list --state open --search '"Scheduled checks failed" in:title' --json title --jq '.[].title' | grep -qx 'Scheduled checks failed' \
  && { echo "the scheduled checks on main are failing (an open 'Scheduled checks failed' issue): fix them first"; exit 1; }

# Every credential is checked before the version is bumped: a failure afterwards leaves a local commit and tag
# to undo. `store-credentials` created the profile; `history` is the cheapest proof that it still authenticates. The
# Android key must open and be the pinned one, and never a debug key.
profile="${ORBITAL_NOTARY_PROFILE:-notarytool}"
releases=${ORBITAL_RELEASES_REPO:-foeken/orbital}
mirror=${ORBITAL_MIRROR_REPO-foeken/orbital-releases}
android=${ORBITAL_ANDROID:-1}
security find-identity -v -p codesigning | grep -q 'Developer ID Application' \
  || { echo "no Developer ID Application identity in the keychain"; exit 1; }
xcrun notarytool history --keychain-profile "$profile" >/dev/null \
  || { echo "notarytool profile '$profile' cannot authenticate; create it with: xcrun notarytool store-credentials"; exit 1; }
[ "$android" = 0 ] || sh scripts/android-release.sh --check

npm version "${1:-patch}"
version=$(node -p "require('./package.json').version")
# @electron/osx-sign signs the helpers inside-out with the hardened runtime and Electron's entitlements, and
# @electron/notarize submits, waits and staples the ticket into the bundle. Both already ship with the packager.
npm run package -- --osx-sign --osx-notarize.keychainProfile="$profile"
app="dist/Orbital-darwin-arm64/Orbital.app"
xcrun stapler validate "$app"
spctl --assess --type execute -vv "$app" # what Gatekeeper will say on a stranger's Mac, before it is published
zip="dist/Orbital-$version-arm64.zip"
rm -f "$zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
# the APK of the same commit, signed and read back (version, key, not debuggable) before anything is pushed
apk=""
if [ "$android" != 0 ]; then apk="dist/Orbital-android.apk"; rm -f "$apk"; sh scripts/android-release.sh "$apk"; fi
# main is protected by a ruleset with no bypass (direct pushes are refused, locally by the global pre-push hook
# and server-side by GitHub), so the version bump lands through a pull request; the tag is pushed on its own.
git switch -c "release/v$version"
git push -u origin "release/v$version"
# the Platforms lines every PR carries (AGENTS.md, Every platform): a version bump lands on none of them
body=$(printf 'Version bump for v%s.\n\n## Platforms\n- **Desktop**: not needed: the version number only\n- **iOS**: not needed: the version number only\n- **Android**: not needed: the version number only\n- **Manual**: nothing user-visible\n' "$version")
gh pr create --title "v$version" --body "$body"
# the checks main's ruleset requires (main-green.yml) start a few seconds after the pull request; merged once they pass
for _ in 1 2 3 4 5 6; do gh pr checks --required --watch >/dev/null 2>&1 && break; sleep 5; done
gh pr merge --merge --delete-branch # a merge commit keeps the tagged commit reachable from main; squash would not
git switch main
git pull --ff-only
git push origin "v$version"
# One opening line for a download by hand, which the update card leaves out (updater.js notes)
notes="Orbital $version for Apple Silicon. Signed and notarized; unzip and move it to Applications."
set -- "$zip"
[ -z "$apk" ] || set -- "$@" "$apk"
gh release create "v$version" "$@" --repo "$releases" --title "v$version" \
  --notes "$notes${apk:+ For Android 10 or later: add https://github.com/foeken/orbital to Obtainium (obtainium.imranr.dev), which installs Orbital and keeps it up to date, or download Orbital-android.apk.}"
# the mirror is for old Mac copies only: the zip, and no APK
[ -z "$mirror" ] || gh release create "v$version" "$zip" --repo "$mirror" --title "v$version" --notes "$notes"
echo "released v$version${apk:+ with Android} to $releases${mirror:+ and $mirror}"
# Slack has no token here: the agent cutting the release posts the notes with its Slack connector.
echo "next: publish what npm run manual-diff -- v$version lists to https://orbital.md/manual (.agents/skills/orbital-manual/SKILL.md, Publishing), write the release notes (gh release edit v$version --repo $releases --notes-file …${mirror:+, and the same for --repo $mirror, whose copy old installs read}) and post them in #orbital on Slack (channel C0C5D5C07EH) with a link to https://github.com/$releases/releases/tag/v$version"
