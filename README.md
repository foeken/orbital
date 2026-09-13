# tana-tasks

Small macOS Electron companion for Tana: a local SQLite list of your open tasks (state "In Progress", assigned to you) in the old Tana Outliner look, synced in the background with the new Tana over its MCP endpoint (OAuth, PKCE).

```
npm install
npm start
```

First run: click "Log in to Tana" (opens the browser once; tokens are stored in the app's userData as tana-auth.json). Sync runs on start, every 60 s, and 2 s after any local edit. Click selects, double click edits the title, the checkbox completes a task (it drops off the list on the next pull), the filter box matches title text, the chevron shows the task body.

CLI for testing the sync module without the UI: `node scripts/tana-cli.js login | pull | content <id> | push <id> <title> <done>` (uses /tmp/tana-tasks-auth.json).
