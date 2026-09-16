# Saved Searches — Phase 1 (read path) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a Tana saved search in the companion and see its results, and list saved searches under a `Searches` group in Cmd+K. No writes, no view removals.

**Architecture:** A saved search (`tana:search:<ulid>`) is a document whose *children* are the rows its stored query returns — exactly how a space's children are the documents it owns. The stored `query` is a root Loro container (not part of `data`), translated to `graph.listNodes` params and mapped through the existing `toNode(graphRow(n))` row pipeline.

**Tech Stack:** CommonJS, no bundler, no framework, no new dependencies. Electron main + preload + classic-script renderer. Checks are plain `node scripts/*-check.js` via `npm run check` — there is no test framework.

**Spec:** `docs/superpowers/specs/2026-09-16-saved-searches-design.md`

## Global Constraints

- CommonJS only. No bundler, no framework, no new dependencies unless a few lines cannot do it.
- `npm run check` must pass before every commit.
- Renderer files are classic scripts sharing one global scope, loaded in the order `index.html` lists them. A later file may use anything an earlier one declares; **no two files may declare the same top-level name** — `scripts/renderer-check.js` fails on either.
- Never declare a top-level `const api` in the renderer (contextBridge global). Use `tana`.
- CSP is `default-src 'self'` — no inline scripts or styles.
- Do **not** extend ACL or move semantics (`sdk/access.js`) — out of scope for this phase.
- Phase 1 is **read-only**. No task here writes to a Tana document.
- **`git` is currently broken in this environment**: `git diff`/`git commit` fail with *"You have not agreed to the Xcode license agreements"*. Run `sudo xcodebuild -license` once before starting, or the commit steps will fail. Do not skip the commits silently — report it if they cannot run.

---

## File Structure

| File | Responsibility in this phase |
|---|---|
| `sdk/query.js` | Add `searchQueryParams()` — stored query → `listNodes` params. Remove the `mcp` filter key. |
| `main/state.js` | Add `isSearch(id)`. |
| `main/related.js` | Add `searchChildren(id)` beside `spaceChildren(id)`. |
| `main/views.js` | Add `searchList()`; remove the MCP row filter. |
| `main.js` | Route `outline:children` for search ids; add the `search:list` IPC. |
| `preload.js` | Expose `searches()`. |
| `renderer/state.js` | Declare `let searches = []`. |
| `renderer/app.js` | Load searches at boot. |
| `renderer/palette.js` | Cmd+K `Searches` group. |
| `renderer/pills.js` | Remove the MCP pill. |
| `renderer/mock.js` | Serve a mock saved search; drop the MCP filter clause. |
| `scripts/sdk-check.js` | Assertions for `searchQueryParams`. |
| `scripts/renderer-behavior-check.js` | Update pill lists; assert the `Searches` group. |
| `docs/VIEWS.md` | Drop `mcp` from the filter vocabulary. |

---

### Task 1: Remove the MCP toggle

The `mcp` filter key can never round-trip into a saved search (`chatInvocationIntents` is absent from the saved-search query schema), so it leaves the filter vocabulary before anything translates that vocabulary. The **`meta: 'MCP'` label stays** — it is informational, not a toggle.

**Files:**
- Modify: `sdk/query.js:71`, `sdk/query.js:86`, `sdk/query.js:95-96`
- Modify: `main/views.js:38`
- Modify: `renderer/pills.js:29`
- Modify: `renderer/mock.js:145`
- Modify: `docs/VIEWS.md:15`, `:26`, `:35`
- Test: `scripts/renderer-behavior-check.js:2176`, `:2190`

**Interfaces:**
- Produces: a filter object with keys `types, states, assignee, text, participant, window` (no `mcp`).

- [ ] **Step 1: Update the failing assertions first**

In `scripts/renderer-behavior-check.js:2176`, remove `'pill:mcp'`:

```js
  assert.deepEqual(plain(api.commands('inbox').map(([id]) => id)), ['pill:type', 'pill:status', 'pill:assigned', 'pill:sort', 'pill:group'],
    'the Inbox is a state rather than a kind, so it still picks types');
```

At `:2190`:

```js
  assert.deepEqual(plain(api.commands('chats').map(([id]) => id)), ['pill:sort', 'pill:group'], 'Chats is chats: layout pills only');
```

- [ ] **Step 2: Run the checks to watch them fail**

Run: `node scripts/renderer-behavior-check.js`
Expected: FAIL — the pill list still contains `pill:mcp`, proving the pill is live.

- [ ] **Step 3: Remove the pill**

Delete `renderer/pills.js:29` entirely:

```js
  if (!f.types || f.types.includes('chats')) defs.push({ id: 'mcp', label: 'MCP chats', command: f.mcp ? 'Hide MCP chats' : 'Show MCP chats', active: !!f.mcp, toggle: () => save({ mcp: !f.mcp }) });
```

- [ ] **Step 4: Remove the filter key**

`sdk/query.js:71`:

```js
  chats: { types: ['chats'] },
```

`sdk/query.js:86`:

```js
const FILTER_KEYS = new Set(['types', 'states', 'assignee', 'text', 'participant', 'window']);
```

`sdk/query.js:95-96` — end the chain at `window` and delete the `mcp` clause:

```js
    && (f.window === undefined || f.window === null || f.window === 'recent');
```

- [ ] **Step 5: Stop filtering rows by it**

`main/views.js:38` — drop the middle filter, keep `isMcp` (still used at `:42` for the label):

```js
  const nodes = result.nodes.filter((n) => !(docsWithoutTasks && idKind(n.id) === 'text' && n.state && n.state.type))
    .filter((n) => !isHidden(memberTitle(n), rules));
```

`renderer/mock.js:145` — drop the `mcp` clause:

```js
      return { nodes: [...all, ...members].filter((d) => (!filter.types ? kindOf(d) !== 'people' : filter.types.includes(kindOf(d)))
        && (!filter.states || listed(d, filter))
        && d.text.toLowerCase().includes(text)).map(info), truncated: false };
```

- [ ] **Step 6: Update the docs**

`docs/VIEWS.md:15` — `{ types, states, assignee, text, participant, window }`.
Delete the `| `mcp` | bool | …` row at `:26`.
`:35` — `chats:    { types: ['chats'] }`.

- [ ] **Step 7: Run the full suite**

Run: `npm run check`
Expected: PASS. If `sdk-check` complains about the `chats` preset, update `scripts/sdk-check.js:921` to `{ nodeTypes: ['chat'], limit: 1000, sortOptions: UPD, mode: COUNT }` — it should already match, since `mcp` never reached `viewParams`.

- [ ] **Step 8: Commit**

```bash
git add sdk/query.js main/views.js renderer/pills.js renderer/mock.js docs/VIEWS.md scripts/renderer-behavior-check.js
git commit -m "Remove the MCP chats toggle: it cannot round-trip into a saved search"
```

---

### Task 2: `isSearch`

**Files:**
- Modify: `main/state.js:42-43`, `main/state.js:70`

**Interfaces:**
- Produces: `isSearch(id) -> boolean`, exported from `main/state.js`.

- [ ] **Step 1: Add the helper**

Beside `isSpace` at `main/state.js:42`:

```js
const isSpace = (id) => id.startsWith('tana:space:');
const isSearch = (id) => id.startsWith('tana:search:'); // a saved search: its "children" are the rows its stored query returns
const idKind = (id) => id.split(':')[1];
```

- [ ] **Step 2: Export it**

Add `isSearch` to the `module.exports` list at `main/state.js:70`, immediately after `isSpace`.

- [ ] **Step 3: Verify nothing broke**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add main/state.js
git commit -m "isSearch: recognise a saved search id"
```

---

### Task 3: Translate a stored query into graph params

The heart of the phase, and the only pure function — so it carries the real tests.

**Files:**
- Modify: `sdk/query.js` (add after `viewParams`, before `module.exports`)
- Test: `scripts/sdk-check.js` (after the `#space` assertions, ~`:952`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `searchQueryParams(query, me, limit = 1000) -> object` — `listNodes` params. Exported from `sdk/query.js`.

- [ ] **Step 1: Write the failing assertions**

In `scripts/sdk-check.js`, after the `#space` assertions, add. Note the first case is the **real** "My Tasks" document from the spec:

```js
    // A saved search's stored query (docs/superpowers/specs/2026-09-16-saved-searches-design.md §2), verified
    // against the real "My Tasks" document: optional keys are absent rather than empty.
    const myTasks = { types: ['text'], entityTypeUris: [], ownerUris: [], createdBy: [], assignedTo: [],
      assignedToViewer: true, participantUris: [], stateTypes: ['proposed', 'open', 'closed', 'not_now'],
      workflowStates: [], attributes: {} };
    assert.deepEqual(searchQueryParams(myTasks, ME), {
      limit: 1000, sortOptions: UPD, mode: COUNT, nodeTypes: ['text'],
      stateTypes: ['proposed', 'open', 'closed', 'not_now'], assignedTo: [ME],
    }, 'the real "My Tasks" search becomes a task query assigned to the viewer');
    assert.equal(searchQueryParams({ types: [] }, ME).nodeTypes.includes('space'), false,
      'an unconstrained saved search still asks only for kinds a view can render, never nodeTypes: []');
    assert.deepEqual(searchQueryParams({ types: ['event'], participantUris: ['tana:user-profile:01examples0000000000000000'] }, ME).hasParticipantUris,
      ['tana:user-profile:01examples0000000000000000'], 'participantUris is the graph\'s hasParticipantUris');
    assert.deepEqual(searchQueryParams({ ownerUris: ['tana:space:01examples0000000000000000'] }, ME).ownerIds,
      ['tana:space:01examples0000000000000000'], 'ownerUris scopes by owner');
    assert.equal(searchQueryParams({ createdByViewer: true }, ME).createdBy[0], ME, 'createdByViewer resolves to the signed-in user');
    assert.equal(searchQueryParams({ textQuery: '  dpa  ' }, ME).textQuery, 'dpa', 'text is trimmed');
    assert.equal(searchQueryParams({ textQuery: '   ' }, ME).textQuery, undefined, 'blank text is not a filter');
    assert.equal(searchQueryParams({ unassigned: true }, ME).unassigned, true);
    assert.equal(searchQueryParams({ visibility: 'private' }, ME).visibility, undefined,
      'visibility has no graph equivalent: preserved in the document, ignored on execute');
```

- [ ] **Step 2: Run it to watch it fail**

Run: `node scripts/sdk-check.js`
Expected: FAIL with `searchQueryParams is not defined`.

- [ ] **Step 3: Implement**

In `sdk/query.js`, after `viewParams`:

```js
// A saved search's stored `query` root container as graph.listNodes params (docs/…/2026-09-16-saved-searches-design.md).
// Every field is guarded: a real search document omits optional keys rather than writing them empty.
// `visibility`, `workflowStates` and `attributes` are deliberately not translated — see the spec's §4.
function searchQueryParams(query, me, limit = 1000) {
  const q = query || {};
  const list = (v) => (Array.isArray(v) && v.length ? v : undefined);
  const p = { limit, sortOptions: UPDATE_DESC, mode: 'LIST_NODES_MODE_WITH_COUNT' };
  // nodeTypes: [] is no filter at all to the graph, which answers with images, calls and transcripts no view can
  // render, so an unconstrained search falls back to the kinds a view lists — the same rule viewParams follows.
  p.nodeTypes = list(q.types) || [...new Set(ANY_KINDS.map((k) => KIND_NODE_TYPE[k]))];
  if (typeof q.textQuery === 'string' && q.textQuery.trim()) p.textQuery = q.textQuery.trim();
  if (list(q.entityTypeUris)) p.entityTypes = q.entityTypeUris;
  if (list(q.ownerUris)) p.ownerIds = q.ownerUris;
  if (list(q.stateTypes)) p.stateTypes = q.stateTypes;
  if (list(q.participantUris)) p.hasParticipantUris = q.participantUris;
  const assigned = [...(list(q.assignedTo) || []), ...(q.assignedToViewer === true && me ? [me] : [])];
  if (assigned.length) p.assignedTo = [...new Set(assigned)];
  const created = [...(list(q.createdBy) || []), ...(q.createdByViewer === true && me ? [me] : [])];
  if (created.length) p.createdBy = [...new Set(created)];
  if (q.unassigned === true) p.unassigned = true;
  const t = q.eventTime;
  if (t && t.min != null) p.eventStartTimeMin = new Date(t.min).toISOString();
  if (t && t.max != null) p.eventStartTimeMax = new Date(t.max).toISOString();
  return p;
}
```

- [ ] **Step 4: Export it**

Add `searchQueryParams` to `sdk/query.js`'s `module.exports`, and to the destructured import at `scripts/sdk-check.js:15`.

- [ ] **Step 5: Run to verify it passes**

Run: `node scripts/sdk-check.js`
Expected: PASS.

- [ ] **Step 6: Falsify one assertion**

Temporarily change `p.nodeTypes = list(q.types) || …` to `p.nodeTypes = q.types || []` and re-run. Expected: the "never nodeTypes: []" assertion FAILS by name. Restore the line and re-run to green. Do not skip this — it is what proves the assertion is not vacuous.

- [ ] **Step 7: Commit**

```bash
git add sdk/query.js scripts/sdk-check.js
git commit -m "searchQueryParams: a saved search's stored query as graph params"
```

---

### Task 4: `searchChildren` — a saved search's rows

**Files:**
- Modify: `main/related.js` (add after `spaceChildren`)
- Modify: `main.js:93`
- Modify: `main/documents.js` — none; `op()` is reused as-is.

**Interfaces:**
- Consumes: `searchQueryParams(query, me, limit)` (Task 3), `isSearch(id)` (Task 2).
- Produces: `searchChildren(id) -> Promise<Node[]>`, exported from `main/related.js`.

- [ ] **Step 1: Implement, mirroring `spaceChildren`**

In `main/related.js`, directly after `spaceChildren`:

```js
// A saved search's "content" is the rows its stored query returns. The query lives in a root Loro container of its
// own (`query`), not in `data`, so readNode never sees it — take it off the document directly.
async function searchChildren(id) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  const query = await op(id, (doc) => doc.loro.getMap('query').toJSON());
  const { nodes } = await S.client.graph.listNodes(searchQueryParams(query, S.me && S.me.userUri, 200));
  nodes.forEach(rememberNodeHue);
  await resolveTypes(nodes.map((n) => n.entityType));
  return nodes.map((n) => toNode(graphRow(n)));
}
```

Add `searchQueryParams` to the `require('../sdk/query')` destructure at the top of `main/related.js`, `op` to the `require('./documents')` destructure, and `searchChildren` to `module.exports`.

- [ ] **Step 2: Route children to it**

`main.js:93`:

```js
ipcMain.handle('outline:children', (_e, id) => (isSearch(id) ? searchChildren(id) : isSpace(id) ? spaceChildren(id) : op(id, (doc) => (idKind(id) === 'chat' ? chatOutline(doc) : doc.content.get('children') ? outlineWithReferences(doc) : []))));
```

Add `isSearch` to the `require('./main/state')` destructure and `searchChildren` to the `require('./main/related')` destructure in `main.js`.

- [ ] **Step 3: Verify**

Run: `npm run check`
Expected: PASS (no assertion covers this path yet; the mock exercise is Task 6).

- [ ] **Step 4: Commit**

```bash
git add main/related.js main.js
git commit -m "searchChildren: open a saved search onto the rows its query returns"
```

---

### Task 5: List saved searches over IPC

`view:list` sets `S.activeView`/`S.activeFilter` and owns the refresh loop, which is wrong for a palette listing — so this is a separate read-only channel.

**Files:**
- Modify: `main/views.js` (add `searchList`, export it at `:143`)
- Modify: `main.js` (IPC handle, beside `search` at `:97`)
- Modify: `preload.js` (beside `search` at `:26`)
- Modify: `renderer/mock.js` (add `searches`)

**Interfaces:**
- Produces: `tana.searches() -> Promise<Node[]>` in the renderer; `search:list` over IPC.

- [ ] **Step 1: Implement in main**

In `main/views.js`, after `search()`:

```js
// Saved searches, newest first. Read-only and view-independent: this does not touch S.activeView or the row cache.
async function searchList() {
  if (!S.client) return [];
  const { nodes } = await S.client.graph.listNodes({
    nodeTypes: ['search'], limit: 200,
    sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }],
  });
  const rules = hiddenRules();
  return nodes.filter((n) => !isHidden(n.title, rules)).map((n) => toNode(graphRow(n)));
}
```

Add `searchList` to `module.exports` at `main/views.js:143`.

- [ ] **Step 2: Expose it**

`main.js`, after the `search` handler at `:97`:

```js
ipcMain.handle('search:list', () => searchList());
```

Add `searchList` to the `require('./main/views')` destructure.

`preload.js`, after `:26`:

```js
  searches: () => ipcRenderer.invoke('search:list'), // saved search documents, newest first
```

- [ ] **Step 3: Serve it in the mock**

In `renderer/mock.js`, the `kinds` array at `:43` already includes `'search'`, so a `tana:search:mock4` row exists. Add to the returned object after `viewList` at `:147`:

```js
    searches: async () => structuredClone(all.filter((d) => d.id.startsWith('tana:search:'))),
```

- [ ] **Step 4: Verify**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add main/views.js main.js preload.js renderer/mock.js
git commit -m "search:list: the saved searches, read-only and view-independent"
```

---

### Task 6: Cmd+K `Searches` group

**Files:**
- Modify: `renderer/state.js:7`
- Modify: `renderer/app.js` (boot load)
- Modify: `renderer/palette.js:127-131`
- Test: `scripts/renderer-behavior-check.js`

**Interfaces:**
- Consumes: `tana.searches()` (Task 5), `goTo(uri)` (existing, `renderer/edit.js`).

- [ ] **Step 1: Write the failing assertion**

Add a new check function to `scripts/renderer-behavior-check.js`, and register it in the `checks` array:

```js
// Saved searches are places to go, so Cmd+K lists them under their own heading.
function runSearchesGroupCheck() {
  assert.match(source, /group: 'Searches'/, 'the palette has a Searches group');
  assert.match(source, /searches = await tana\.searches\(\)|tana\.searches\(\)/, 'and the renderer loads them from the read-only channel');
}
```

- [ ] **Step 2: Run it to watch it fail**

Run: `node scripts/renderer-behavior-check.js`
Expected: FAIL — `the palette has a Searches group`.

- [ ] **Step 3: Declare the state**

`renderer/state.js`, after `:7`:

```js
let searches = [];           // [{ id, title, icon, … }] saved search documents, for the Cmd+K Searches group
```

- [ ] **Step 4: Load at boot**

`renderer/app.js:73` is the boot line — `loadRoots().then(render, showError).then(loadFilters);`, the last
statement before `tana.status()`. Add the saved-search load directly after it, as its own statement:

```js
loadRoots().then(render, showError).then(loadFilters);
if (tana.searches) tana.searches().then((list) => { searches = list || []; renderSoon(); }, () => {}); // Cmd+K only: never blocks the first paint
tana.status().then(showStatus, showError);
```

It is deliberately not chained onto `loadRoots`: the Searches group is palette-only, so a slow or failing search
listing must not delay or break the first paint. The empty `catch` matches how the other optional loads behave —
a signed-out or older main process simply has no `tana.searches`.

- [ ] **Step 5: Add the group**

`renderer/palette.js`, after the `viewRows` push at `:131`:

```js
  // Saved searches are places too: their own heading, under the views, each opening the search document
  rows.push(...searches.map((s) => ({ id: 'search:' + s.id, group: 'Searches', icon: 'search', label: s.text || s.title || 'Untitled search', run: () => goTo(s.id) })));
```

- [ ] **Step 6: Run to verify it passes**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 7: Drive it in the mock**

Open the app against the in-file mock (no main process), press Cmd+K, and confirm a `Searches` heading listing `Sample search`. Selecting it opens the search document.

- [ ] **Step 8: Commit**

```bash
git add renderer/state.js renderer/app.js renderer/palette.js scripts/renderer-behavior-check.js
git commit -m "Cmd+K: saved searches under a Searches heading"
```

---

### Task 7: Record the work

**Files:**
- Modify: `TASKS.md` (append row 247)
- Modify: `docs/VIEWS.md` (note the search kind)

- [ ] **Step 1: Append the TASKS.md row**

Use the next integer after the highest existing row, following the house style: request, root cause/what changed, the evidence, and what was **not** verified. State plainly that phase 1 is read-only, that writes are phase 2, and that the `data`-map fields for create remain unverified (spec §10).

- [ ] **Step 2: Run the suite one last time**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add TASKS.md docs/VIEWS.md
git commit -m "TASKS.md: saved searches phase 1 (read path)"
```

---

## Self-Review

**Spec coverage:** §4 read path → Tasks 2-4. §5 cache → untouched by design (`searchChildren` bypasses `db.replaceSection`; saved searches are not a cached section in phase 1). §7/§8 MCP removal → Task 1. §3 Cmd+K group → Task 6. §9 phase 1 scope → the whole plan. §6 write path, §8 preset/People removal → **deliberately out of scope**, phases 2-4.

**Placeholder scan:** every step carries the literal code or the exact assertion text. The one judgement call left to the executor is the TASKS.md row wording (Task 7 Step 1), which is prose by nature and has its required content enumerated.

**Type consistency:** `searchQueryParams(query, me, limit)` is defined in Task 3 and consumed with that exact signature in Task 4. `isSearch(id)` is defined in Task 2 and used in Task 4. `tana.searches()` is produced in Task 5 and consumed in Task 6. `searchChildren(id)` is produced in Task 4 and wired in the same task.

**Known limitation, deliberately not a task:** `eventTime.preset` (`recent | upcoming | today | past`) is not translated — only explicit `min`/`max` are. Inventing window semantics for the presets would be guessing; the spec records it, and a search using a preset simply returns an unwindowed result in phase 1.
