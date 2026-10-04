# Orbital for iPhone

A native SwiftUI app over Orbital's own JavaScript SDK (issue #658). A hidden web view on
`https://home.tana.inc/api/auth/session` runs `engine/`: `sdk/` with the desktop's `main/timeline.js` and
`main/settings.js`, bundled into one script. SwiftUI asks `window.orbital` for rows and draws them.

## What a build needs

- Xcode 26 or later.
- [Bun](https://bun.sh), which bundles the engine in an Xcode build phase: `brew install oven-sh/bun/bun`.
- The repository's `node_modules` (the engine bundles `loro-crdt` from it): `npm install` in a clone, or
  `npm run modules` in a worktree.
- For the saved-search icons, `build/nucleo-ui.json.gz` (`node scripts/build-nucleo.js` from a local Nucleo library).
  Without it every search keeps the magnifier.

## Building

```sh
cd ios
xcodebuild -project Orbital.xcodeproj -scheme Orbital -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
# an install link for an iPhone (Sqim, development-signed)
sqim upload --device . --build --project Orbital.xcodeproj --scheme Orbital --team-id 6DA7MK99T2 --allow-provisioning-updates
```

## Design shots in the simulator

Launch arguments, all on invented content (`Orbital/timeline-sample.json`, `Orbital/pages-sample.json`): `-sample`
(no Tana at all), with `-history` (the day's entries only), `-zoom <id>` (a node open), `-menudemo` (the menu opens
and closes), `-settings` and `-typing`.

## Checks

`npm run check` runs `scripts/ios-engine-check.js`: the engine's stand-ins always, and with Bun installed also the bundle
itself, driven in a vm made to look like the session page.

`OrbitalUITests` drives the app itself on `-sample`, finding everything by the label VoiceOver reads: the Timeline, ticking a
task, a sensitive task's hidden words, the menu and a saved search, a meeting's page, Ask Tana, Quick Add and Settings. The
iOS workflow runs it on a simulator when anything under `ios/` changes, a quarter of an hour a run; locally, in a minute or
so, with the Android app's screen tests beside it (`scripts/phones.sh`):

```sh
npm run phones        # both; npm run phones ios, or android, for one
```

A new Xcode needs its first-launch install (`sudo xcodebuild -runFirstLaunch`) before any simulator starts: without it
`xcrun simctl` hangs and builds say "CoreSimulator is out of date".
