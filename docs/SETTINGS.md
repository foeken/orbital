# SETTINGS.md — the app's own settings document

Everything this app decides *about your content* lives in one document in Tana, so the choices you make on one
machine are the choices the app opens with on the next. Machine-only secrets are the exception: they stay in the
local SQLite settings table. The document is created by the app, titled **Orbital**, and its first line says so.
Deleting it in Tana puts every synced choice back to its default; nothing else breaks.

## Why a document of our own

Tana has nowhere to keep this: `appearance` holds an image uri and a hue, and there is no field for "the glyph this
type is drawn with" or "the titles I never want to see". A key Tana does not know *can* be written into a document's
data map — a scratch document given `data.companionIcon = 'rocket'` still carried it when a fresh process read it
back (2026-09-20) — but the documents those settings are *about* are shared, and our vocabulary has no business in
somebody else's type. A document the app creates is ours to shape, is visible and deletable like any other note, and
leaves every other document alone.

## Where the values are

A root container of its own (`ext:orbital`), one JSON string per key — the same shape the SQLite settings table has
always had, which is what lets SQLite stay a mirror rather than become a second design:

```
ext:orbital: { "hiddenTitles": "[\"Lunch\"]", "typeIcons": "{\"tana:type:…\":\"rocket\"}", "pref:home": "\"library\"" }
```

The `ext:` prefix marks the root as an extension's rather than Tana's, on Eirik Hoem's advice (2026-09-23): Tana may
give documents a root of its own called `settings` one day, and ours must not be the one in the way. Older builds
wrote to a root named `settings`; the next hydrate moves those keys into `ext:orbital` (a key already there wins)
and empties the old root.

Reads are synchronous everywhere (every listed row asks for its type's glyph), so main keeps the values in memory:
filled from SQLite the moment the app opens — the last known answer, before the network — and replaced by the
document when sync connects. A write goes to all three: memory, SQLite, Tana. Offline, the first two still work and
the third catches up on the next connect.

## What follows you, and what does not

| Follows you | Stays on the machine |
|---|---|
| View filters (`viewFilter:*`), hidden titles, the MCP switch | The window's size and position |
| Type icons and the colour a type is drawn in (`typeIcons`, `typeHues`), sensitive marks, watch choices (`notify`), which model the AI rows use ("Discuss with" and "Classify type") and how hard it thinks (`aiModel`, `aiEffort` — no UI yet, defaults in main/ai.js) | Which page you had open, where you were zoomed, whether sensitive items are unblurred (`sensitiveVisible`), the OpenAI API key (`openaiApiKey`), and ChatGPT auth in a separate, isolated Codex home under userData |
| Agent assignments, their prompts, the machines they can run on, and the tasks they became (`codexTask`) | The row cache, which is a mirror of Tana and is rebuilt by any refresh |
| Which saved search is the Work View's My Tasks (`myTasks`, its id: a rename keeps it, two machines share it) | |
| Renderer preferences (`pref:*`): Home, recorded hotkeys, theme, sort, grouping, which facts a row shows, folded sections, the sidebar's open/closed state | Recently viewed, the sidebar's width, the row cache, and ChatGPT auth in its isolated local Codex home |

The rule is the purpose: a choice about your content is the same choice wherever you open the app; a choice about
*this screen* is not. `notifySeen` — what has already been announced — stays local for a different reason: it changes
on every watched node's every move, and syncing it would rewrite the document all day for no gain.

`codexTask` (node → `{ host, threadId }`) is in the first column because a Codex thread id is global and the record
names the machine whose rollout it is. Another machine can then draw the badge and say *where* the work is — "Agent
task is on Donut", which the palette already knows how to show — instead of a node that looks like it was never
handed over. Only opening it stays local, as it always was.

## Finding it, and merging

Each machine notes the document's uri locally, so it costs one lookup per machine. Without that note — a new machine,
a cleared cache — the app finds it by title among your own documents, oldest first, so two machines that both created
one at the same moment settle on the same document rather than drifting apart. Nothing is found: it is created.

On connect, the document decides: a key it holds replaces what this machine remembered, and a key only this machine
has is pushed up. That is what makes the first run on an existing install a migration with no migration step. Between
machines, Loro's last-write-wins per key applies — two machines changing *different* settings both keep theirs.

## The renderer's half

The renderer's preferences are the same store under a `pref:` prefix. preload reads them **synchronously** at load
(`prefs:snapshot`), so `renderer/prefs.js` has them before the first paint and a launch is already yours rather than
the defaults with your choices arriving a moment later; `setPref` writes one key through main. When another machine
changes something, main sends `settings:changed` and `renderer/app.js` applies it to what is already on screen —
theme, Home, hotkeys, the arrangements and the folded sections.

One trap, paid for once: `contextBridge` **freezes** everything it exposes, so `window.api.prefs` is a frozen
object and the store must keep a *copy* of it (`{ ...window.api.prefs }`). Writing into the bridge's own object
throws in a strict-mode script, before the write reaches main and before whatever line follows it — which is how
folding a group heading quietly stopped redrawing and no preference was stored at all (#311).

## Not in the document

The row cache (SQLite `nodes`) is a mirror of Tana and is rebuilt by any refresh; the sensitive-marks table is the
pre-settings home of those ids and is read once, to seed the synced list. Neither belongs in Tana.
