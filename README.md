# tana-tasks

Small macOS Electron companion for the new Tana, rendered as a Tana-Outliner-style outline: every line is a node, top-level nodes are Tana documents and their children are the document's content blocks. Kept live through Tana's own platform sync (Connect-RPC + Loro CRDT); edits are written back instantly. The first view is Tasks (open tasks assigned to you).

```
npm install
npm start
```

First run: click "Log in to Tana"; a window opens on home.tana.inc and you sign in as usual. The cookie session is kept in the app's own partition and used in the background from then on. The list refreshes every 60 s (and via Tasks > Sync with Tana, Cmd+R); every listed document is subscribed for live updates, so changes made in Tana show up within a second. Text is edited in place. Enter splits or creates a node, Tab and Shift+Tab nest and unnest, Backspace on an empty node removes it, arrows move between nodes, Cmd+Up/Down collapse and expand, Cmd+Enter or the checkbox completes a task (state "closed"; it drops off the list on the next refresh), clicking a bullet zooms in. The filter box matches document titles. See docs/OUTLINER.md.

Layout: `sdk/` is a generic Tana platform client (graph queries, sync stream, Loro documents, node accessors; see sdk/README.md, docs/SDK.md and docs/PLATFORM-PROTOCOL.md). `tana-session.js` is the Electron login/session layer. `main.js` wires tasks (a query on the SDK) to the local SQLite store and the renderer.

Icons come from the Tana line icon set (Nucleo export in ~/Documents/Tana icons (line)); `node scripts/build-icons.js` regenerates icons.js as greyscale inline SVG.

Checks: `npm run check`. CLI for poking the platform without the UI: `npm run tana -- login | whoami | list | get <id> | outline <id> | watch <id...> | set-title <id> <title>`.

This uses Tana's undocumented v1alpha1 protocol as reverse-engineered from their web client; expect it to break when they change it.
