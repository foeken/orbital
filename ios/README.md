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
(no Tana at all), with `-history` (the day's entries only), `-zoom <id>` (a node open), `-menu` (the menu open),
`-menudemo` (the menu opens and closes), `-settings`, `-add` and `-typing`. `sh manual/scenes/iphone.sh` takes the
manual's iPhone pictures with them.

## Checks

`npm run check` runs `scripts/ios-engine-check.js`: the engine's stand-ins always, and with Bun installed also the bundle
itself, driven in a vm made to look like the session page.

`OrbitalUITests` drives the app itself on `-sample`, finding everything by the label VoiceOver reads: the Timeline, ticking a
task, a sensitive task's hidden words, the menu and a saved search, a meeting's page, Ask Tana, Quick Add and Settings. The
scheduled checks run it on a simulator on main (.github/workflows/checks.yml), a quarter of an hour a run; locally, in a minute or
so, with the Android app's screen tests beside it (`scripts/phones.sh`):

```sh
npm run phones        # both; npm run phones ios, or android, for one
```

A new Xcode needs its first-launch install (`sudo xcodebuild -runFirstLaunch`) before any simulator starts: without it
`xcrun simctl` hangs and builds say "CoreSimulator is out of date".

## Widgets

`ios/Widgets` is a WidgetKit extension, as the Android app's widgets: **Today's Tasks** (small, medium, large), each task a
whole line; **Today's Tasks and Upcoming Meetings** (medium, large), the Timeline above its line, with + for Quick Add; and
**Activity** (medium, large), what happened by day, each line its marker and the task or node itself, each task once at the
latest thing that happened to it (`Glimpse.activity`, `Row.asTask`), with no +. On the Lock Screen, **Quick Add**. A widget
does not scroll, so each draws as much as fits its height. They draw what the app last read (`Engine.keepTimeline`, the same
JSON as Android's `Glimpse`), left in the Keychain in Orbital's own access group as the Share extension leaves what it
shares; a sensitive row comes without its words. On a tinted or clear Home Screen iOS draws everything in one tint, so the
markers have nothing laid behind them and the boxes are outlines there (`widgetRenderingMode`). A tap opens `orbital:<id>`,
`orbital:add` or `orbital:timeline` in the app (`Shell.swift`); a task's box is a button of Orbital's own
(`WidgetIntents/TickTask.swift`, compiled into the app and the widgets) that opens the app, which ticks the task and writes
it to Tana at once (`Engine.tick`); run in the widget's process, which has no engine, it leaves the tick in Orbital's own
Keychain group for the app to take as it comes forward. The extension's glyphs are its own catalog, made with the app's
(`node scripts/build-ios-glyphs.js`). A device build needs the `com.dreetje.orbital.widgets` id registered for the team,
and a profile for it: with no Apple account in Xcode, automatic signing falls back to the team's wildcard profile, whose
older app id prefix makes iOS leave the widgets out. `WidgetTests` adds them on the simulator's home screen and uses them;
built with signing off (`CODE_SIGNING_ALLOWED=NO`, as CI builds) the widgets have no Keychain group to read, so it skips
once it has seen a widget added.

## Siri, Shortcuts and Spotlight

`Orbital/Intents.swift` (issue #723) gives Siri and Shortcuts Orbital's tasks as an App Entity (`TaskEntity`) and what can be
done with one: **Add Task** (pinned to today or not), **Check Off Task**, **Uncheck Task**, **Pin Task to Today** (or unpin),
**Open Task**, **Today's Tasks**, and **List Tasks** (by status, all but the completed ones unless you choose). Tana is written
by the engine, which runs in the app, so whatever changes a task opens Orbital and runs there, writing through its engine
as soon as Tana is connected. Today's Tasks and List Tasks run in the background and answer
from what the app last saved: the widgets' copy, and the tasks assigned to you, read at most every five minutes and again when
Demo mode changes (`Engine.keepTasks`); Siri finds a task among those by the words you say. A sensitive task is never said or
indexed, only named as one. `OrbitalShortcuts` gives Siri its phrases with no shortcut set up first ("Add a task in
Orbital", "What's on today in Orbital", "Check off … in Orbital"), Spotlight indexes those same tasks (none in
Demo mode or once signed out), and each task box carries its entity (`appEntityIdentifier`) so "check this off" knows which.
The Android app has no counterpart yet: Gemini's AppFunctions are an alpha (#723).

## Links from other apps

iOS does not say who opened a link, so an `orbital:` link writes nothing, whoever sends it: Orbital's own widgets and Siri
write through intents instead. `orbital:<id>`, `orbital:timeline` and `orbital:add` open as ever; `orbital:check:`,
`uncheck:`, `pin:` and `unpin:<id>` open that node, where you tick it or pin it yourself (Pin to Today is on its page),
and `orbital:new?title=…` opens Quick Add with the title filled in, added only when you press Add (`Shell.swift` open), as
Android holds the same links (docs/ANDROID.md, Security). `SampleTests` holds both.
