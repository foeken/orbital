# tana-tasks

Small macOS Electron companion for the new Tana: your open tasks in the old Tana Outliner look, kept live through Tana's own platform sync (Connect-RPC + Loro CRDT), with edits written back instantly. No MCP involved.

```
npm install
npm start
```

First run: click "Log in to Tana"; a window opens on home.tana.inc and you sign in as usual. The cookie session is kept in the app's own partition and used in the background from then on. The list refreshes every 60 s (and via Tasks > Sync with Tana, Cmd+R); every listed task is subscribed for live updates, so changes made in Tana show up within a second. Click selects, double click edits the title, the checkbox completes a task (state "closed"; it drops off the list on the next refresh), the filter box matches title text, the chevron shows the task body.

Layout: `sdk/` is a generic Tana platform client (graph queries, sync stream, Loro documents, node accessors; see sdk/README.md, docs/SDK.md and docs/PLATFORM-PROTOCOL.md). `tana-session.js` is the Electron login/session layer. `main.js` wires tasks (a query on the SDK) to the local SQLite store and the renderer.

Checks: `npm run check`. CLI for poking the platform without the UI: `npm run tana -- login | whoami | list | get <id> | watch <id...> | set-title <id> <title>`.

This uses Tana's undocumented v1alpha1 protocol as reverse-engineered from their web client; expect it to break when they change it.
