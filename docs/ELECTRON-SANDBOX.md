# Why the CLI crashed with "Electron quit unexpectedly"

**Symptom.** macOS crash dialogs for *Electron* (com.github.Electron, the copy in `node_modules`), several
per hour, while agents worked in this repo. 53 crash reports in
`~/Library/Logs/DiagnosticReports/Retired/Electron-*.ips` on 2026-09-13/14 alone, all with the same stack:

```
abort() <- ___RegisterApplication_block_invoke <- _RegisterApplication <- GetCurrentProcess
       <- -[NSMenuBarPresentationInstance _getAggregateUIMode:] <- _NSInitializeAppContext
       <- -[NSApplication init] <- +[NSApplication sharedApplication] <- ElectronMain
```

**Cause.** Not our code: the abort happens ~400 ms after launch, inside AppKit, *before* the main script
loads. AppKit registers every GUI process with LaunchServices; inside an agent sandbox
(`CODEX_SANDBOX=seatbelt`) launchservicesd is unreachable, so registration aborts. Measured:

| run | result |
|-----|--------|
| `electron scripts/platform-cli.js` in the sandbox | SIGABRT, 1 crash report, **every** run (10/10, then 25/25) |
| same binary with escalated/unsandboxed permissions | exits 0, no report |
| `ELECTRON_RUN_AS_NODE=1` in the sandbox | fine — no NSApplication, no abort |
| `lsappinfo list` in the sandbox | 0 lines (1061 unsandboxed) — LaunchServices is gone |

So the CLI never ran at all under an agent: it aborted at startup and each abort raised a dialog.
Ruled out: the `postinstall` `plutil` patch of `Info.plist` (re-signing the bundle ad-hoc changes nothing),
the parent process having exited (`parentProc: "Exited process"` shows even when the shell waits),
and anything reachable from JS — `app.dock.hide()`, activation policy, `app.exit(0)` all run too late.

**Fix.** `scripts/platform-cli.js` is now started by **node**, and under node it is only a launcher: it
refuses with exit 3 and a one-line explanation when `CODEX_SANDBOX` is set, and otherwise re-execs the
Electron binary with the same arguments, inheriting stdio and the exit code.

```bash
node scripts/platform-cli.js list          # not ./node_modules/.bin/electron
```

Run it with escalated (unsandboxed) permissions — GUI Electron cannot work otherwise. Verified: 25
sandboxed runs produce a clear error and **no** new crash report; 5 unsandboxed runs return real data.

**Still true elsewhere.** `npm start`, `npm run icon` and the packaged Tana Companion app hit the same
wall in a sandbox (there is one `Tana Companion-*.ips` with this stack); run them unsandboxed.
`AGENTS.md` still shows the old `./node_modules/.bin/electron scripts/platform-cli.js` form — that
invocation crashes in a sandbox and should be updated by whoever owns that file.
