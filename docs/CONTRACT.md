# tana-tasks contract

Small macOS Electron app: a local task list that mirrors the user's open tasks in the **new Tana** (home.tana.inc) and syncs edits back in the background over Tana's MCP endpoint.

Runtime: Electron 44 (Node >= 22, so `node:sqlite` is available in the main process). Plain CommonJS JavaScript, no bundler, no TypeScript, no framework. Dependencies already installed: `electron`, `@modelcontextprotocol/sdk`. Do not add dependencies.

## Files and owners (disjoint write sets)

- Worker A (shell): `main.js`, `preload.js`, `db.js`
- Worker B (renderer): `index.html`, `renderer.js`, `styles.css`
- Worker C (sync): `tana.js`, `scripts/tana-cli.js`
- Coordinator: `package.json`, `docs/*`

You are not alone in the codebase. Other workers edit the other files in parallel. Never revert or rewrite files you do not own; code against the contracts below.

## Task record (shared shape)

```js
{ id: 'tana:text:…',   // the Tana item URI is the primary key; there is no local id
  title: string,
  done: 0 | 1,          // 1 = Tana state "Completed", 0 = "In Progress"
  space: string|null,   // human-readable owner/space name from Tana, shown grey after the title
  content: string|null, // markdown body, null until loaded lazily
  updatedAt: string,    // ISO 8601 from Tana (or local edit time)
  dirty: 0 | 1 }        // 1 = local edit not yet pushed
```

## SQLite (db.js, node:sqlite, file at app.getPath('userData') + '/tasks.sqlite')

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
  space TEXT, content TEXT, updatedAt TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 0);
```

db.js exports: `open(path)`, `list()`, `get(id)`, `update(id, {title?, done?})` (sets dirty=1, updatedAt=now, returns row), `setContent(id, content)`, `dirtyRows()`, `markClean(id)`, `replaceFromTana(rows)` (upsert every pulled row; do NOT overwrite title/done of rows with dirty=1; delete local rows whose id is not in the pulled set and that are not dirty; keep existing `content` when the pulled row has content null).

## Renderer API (preload.js exposes `window.api`, main.js implements the IPC)

```js
window.api.listTasks()                 // Promise<Task[]>
window.api.updateTask(id, {title?, done?}) // Promise<Task>; main updates db, then triggers a push soon (debounced ~2s)
window.api.loadContent(id)             // Promise<string>; returns db content if cached, else fetches via tana.readContent, caches, returns
window.api.syncNow()                   // Promise<{ok:boolean, error?:string}>
window.api.status()                    // Promise<{authenticated:boolean, syncing:boolean, lastSync:string|null, error:string|null}>
window.api.login()                     // Promise<void>; runs the OAuth flow (opens system browser), then syncs
window.api.onTasksChanged(cb)          // cb() after any pull or content update; renderer re-calls listTasks
window.api.onStatus(cb)                // cb(status) whenever status changes
```

IPC channel names (main.js / preload.js): `tasks:list`, `tasks:update`, `tasks:content`, `sync:now`, `sync:status`, `sync:login`; push events `tasks:changed`, `sync:status`.

## Sync module (tana.js, CommonJS, used by main.js and scripts/tana-cli.js)

```js
const tana = require('./tana');
tana.init({ authFile, openUrl })       // authFile: path to JSON with OAuth client info + tokens; openUrl(url): opens browser (shell.openExternal in Electron, 'open' in CLI)
tana.isAuthenticated()                 // Promise<boolean>  (has tokens on disk)
tana.login()                           // Promise<void>: OAuth 2.1 authorization-code + PKCE with dynamic client registration against https://home.tana.inc/mcp (discovery works: 401 with resource_metadata, /.well-known/oauth-authorization-server on home.tana.inc, registration_endpoint https://login.tana.inc/oauth2/register, S256, scopes openid profile offline_access). Use @modelcontextprotocol/sdk's StreamableHTTPClientTransport + an OAuthClientProvider implementation; redirect to a loopback http server on 127.0.0.1 (random free port), exchange the code, persist tokens to authFile. Refresh tokens transparently.
tana.pullTasks()                       // Promise<Array<{id, title, done, space, updatedAt}>>: all tasks assigned to the current user with state "In Progress" (use getCurrentUser for the URI; searchItems with queries ['*'], targets [{target:'text', state:['In Progress'], assignedTo:[me]}], limit 500, sortOptions updateTime desc). done is 0 for all of these. content is NOT fetched here.
tana.readContent(id)                   // Promise<string>: readItems([id]) -> markdown body ('' if empty). Do not pass task.
tana.pushTask({id, title, done})       // Promise<void>: updateItems({ autoApprove: true, updates:[{ id, title, state: done ? 'Completed' : 'In Progress' }] }). If the response indicates a pending proposal with a sessionUri instead of an applied change, call approveProposals({sessionUri}) so background sync actually lands.
```

All MCP calls go through one lazily-created Client (`client.callTool({name, arguments})`); tool result text is JSON in `result.content[0].text`. Tool names on the server are camelCase without prefix: getCurrentUser, searchItems, readItems, updateItems, approveProposals, listProposals. Confirm exact names with `client.listTools()` on first connect and fail loudly if missing. Full descriptions of the tool schemas are in docs/tana-mcp-tools.md.

## Sync loop (main.js)

On ready: open db, tana.init, create window. If authenticated: sync now, then every 60s. Sync = push every dirty row (pushTask, then markClean) -> pullTasks -> db.replaceFromTana -> send `tasks:changed`. Any error goes into status.error and is shown by the renderer; never crash. updateTask schedules a push+pull 2s later (debounced).

## UI (renderer)

Old Tana Outliner look (see the two screenshots in docs/): white page, big "Open Tasks" title, a filter input row under it, then one row per task: small grey task icon, square checkbox, title text, grey space name after the title. Filter matches title substring case-insensitively and shows "N items filtered out" under the list. Interactions: click a row selects it (light grey background); double click makes the title editable inline (contenteditable, Enter/blur saves via updateTask, Esc cancels); checkbox toggles done (row shows strikethrough/grey while done until the next pull drops it); a chevron at the far left expands the row to show the task content underneath (loaded via loadContent, rendered as plain text with line breaks preserved; a spinner/"loading…" while fetching). A thin status line at the bottom shows lastSync / error / a "Log in to Tana" button when not authenticated, and a "Sync" button. Keyboard: up/down move selection, space toggles done, Enter edits. Keep it one HTML file + one JS file + one CSS file, no framework.

