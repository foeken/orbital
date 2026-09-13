# Tana MCP tool schemas (captured from the Tana plugin; server tool names are the part after tana_, camelCase: searchItems, readItems, updateItems, approveProposals, listProposals, createItems, getCurrentUser)


===== mcp__codex_apps__tana_searchitems
Access your Tana graph

Search for documents using full-text search. Supports multiple queries in one call - always batch your searches instead of calling multiple times.

Example - search text documents of a user-defined type:
{
  "queries": ["Alice", "Bob", "Project Alpha"],
  "targets": [{ "target": "text", "type": "Person" }]
}

Example - list all user-defined skills:
{
  "queries": ["*"],
  "targets": [{ "target": "skill" }]
}

Example - find a custom agent by name or purpose:
{
  "queries": ["customer research"],
  "targets": [{ "target": "agent" }]
}

Example - find open tasks assigned to a user:
{
  "queries": ["*"],
  "targets": [{ "target": "text", "state": ["In Progress"], "assignedTo": ["tana:user-profile:XXXX"] }]
}

Example - find open tasks with no assignee:
{
  "queries": ["*"],
  "targets": [{ "target": "text", "state": ["In Progress"], "unassigned": true }]
}

Example - filter a typed entity by its field values (reference + date fields):
{
  "queries": ["*"],
  "targets": [{ "target": "text", "type": "Outcome", "fieldFilters": [
    { "field": "Product area", "matchAny": ["<Product area option uri from getTypes>"] },
    { "field": "Reported", "after": "2026-01-01" }
  ] }]
}

Use `fieldFilters` to filter instances of a user-defined type by the values in its fields (e.g. "Outcomes in Product area X", "Tasks whose Owner is Alice", "Bugs reported this month", "Deals worth over 10000"). It requires a single `type`, since field names are resolved against that type's schema. First call getTypes for that type: it returns each field's name and kind, and — for bounded reference fields — the selectable option `{name, uri}` pairs. Pass the chosen option URIs in `matchAny` (or user-profile URIs from the team-members list for member fields). If getTypes lists no options for a reference field (its target vocabulary is too large to inline), resolve the specific value before filtering — and use the matched `id` in `matchAny`; prefer this targeted lookup over listing every instance, which a large vocabulary will truncate. When you know the value by name, keyword-search the referenced type (`searchItems` with `type` set to that type and `queries: ["Globex"]`). When the value is described conceptually rather than by its exact name (e.g. picking the category that best fits a fuzzy theme), use `semanticSearchItems` with the same `type` to find the closest-matching instance. For date fields use `after`/`before` — local `YYYY-MM-DD` for a floating calendar day (matches that day for everyone), or `YYYY-MM-DDThh:mm` plus `timeZone` for a wall-clock instant; use the user's IANA zone from the chat context unless they explicitly ask for another timezone. Bounds are inclusive. For free-form fields use `equals`/`startsWith` (case-insensitive text) or `min`/`max` (inclusive numeric window, for fields holding a number). Across entries the filters AND; within an entry they OR. Tasks are built-in — filter their workflow with `state`, not `fieldFilters`.

Example - search spaces:
{
  "queries": ["Engineering"],
  "targets": [{ "target": "space" }]
}

Example - find MCP chats:
{
  "queries": ["*"],
  "targets": [{ "target": "chat", "invocationIntents": ["mcp"] }]
}

Other targets ("canvas", "transcript", "call", "chat", "artifact", "event") follow the same shape — e.g. `[{ "target": "canvas" }]` or `[{ "target": "text" }, { "target": "canvas" }]` for a combined search.

Agent keyword searches match title, curated purpose/`description`, and instructions. They return user-created agent definitions with their `description` when available; built-in agents are hidden unless the target sets `includeSystem: true`. Use `readItems` with the returned agent URI only when the full instructions or configuration are needed.

Event-specific filters (only apply when targeting events):
{
  "queries": ["planning"],
  "targets": [{ "target": "event", "eventStartTimeMin": "2026-01-01T00:00:00", "eventStartTimeMax": "2026-01-31T23:59:59", "eventTimeZone": "Europe/Oslo" }]
}
{
  "queries": ["*"],
  "targets": [{ "target": "event", "hasParticipantUris": ["tana:user-profile:ALICE", "tana:user-profile:BOB"] }]
}

For event start-time bounds, pass local ISO 8601 wall times without UTC offsets and set `eventTimeZone`. Use the user's timezone from the chat date/time context unless the user explicitly asks for another timezone. The server resolves offsets and daylight-saving transitions; event result times are rendered in the same timezone.

Event results include an `event` object with compact time/status, people, location when present, and email domains when the participant list is truncated. The top-level `id` is the canonical event URI. Use the metadata fields to distinguish internal planning meetings from customer or external sessions; a title keyword like "onboarding" is not enough by itself.

When targeting events, `queries` search event title/content plus organizer and attendee names/emails from calendar metadata. Use this for "meetings with alice@example.com" or "events organized by Alice". `hasParticipantUris` is different: it filters by Tana user-profile URIs in the event's participant ACL, not arbitrary calendar attendee names/emails.

When targeting chats, `invocationIntents` filters by indexed chat purpose, such as `mcp`, `proposal-iteration`, `meeting`, or `agent-routine`.

Top-level filters apply across all targets:
- `space`: single space URI (shorthand); `ownerIds`: multiple owners with OR-semantics.
- `itemIds`: look up specific URIs in bulk (returns row metadata, not content). Omit `targets` to have them inferred from the URI kinds.
- `sortOptions`: override default order. Fields: `createTime`, `updateTime` (most-recently-edited), `userLastModifiedAt` (pairs with `modifiedByUser` — sorts by when that user last touched each item), `title` (alphabetical), `textRank` (FTS relevance — every query in the batch must be non-wildcard).

Use '*' as a query to list all items. Returns IDs for use with readItems — and for chat replies: when you mention a returned document by name, format it as `[Title](id)` using the `id` field verbatim (it is already the full URI, e.g. `tana:text:abc123` — do NOT prepend `tana:text:` again). The chat client renders this as a clickable chip. Bold or plain text for a document name is a UX bug.

Each result includes `createdAt` and `updatedAt` (ISO 8601) when available. Chat-local proposal rows that have not been committed can omit these fields. Use them to explain creation and update timing for returned hits.

Document results include the immediate structural `ownerUri` when available. An owner may be a space, event, chat, or another document — only treat it as a space when the URI starts with `tana:space:`. Never change the URI kind. Optional `space` is a human-readable name and is only present when the owner resolves to a known space.

Not supported — tell the user these can't be done rather than approximating:
- Date-range filter on last-edited / create time (use the updateTime / createTime sort + small limit for "N most recent" — that is not a true date range).
- NOT / exclusion conditions ("tasks NOT assigned to Alice", "everything except Bugs") — the filter surface is AND-only.

For discovery queries, present each match to the user as a `[title](uri)` markdown link — the chat renders any tana URI as a clickable reference. Only call a reader when you actually need the content: readItems for text/skill/artifact/image/asset, readTranscript (pass a `task`) for `tana:call:`, readEvent for `tana:event:`. For kinds with no dedicated reader (canvas, chat), the link IS the deliverable — don't apologize that you "can't read" them. This tool is part of plugin `Tana`.

exec tool declaration:
```ts
declare const tools: { mcp__codex_apps__tana_searchitems(args: { externalIds?: { [key: string]: string; } | null; itemIds?: Array<string> | null; limit?: number | null; modifiedByUser?: string | null; ownerIds?: Array<string> | null; queries: Array<string>; sortOptions?: Array<{ direction: "asc" | "desc"; field: "createTime" | "updateTime" | "userLastModifiedAt" | "title" | "textRank"; }> | null; space?: string | null; targets?: Array<{ assignedTo?: Array<string> | null; fieldFilters?: Array<{ after?: string | string | null; before?: string | string | null; equals?: string | null; field: string; matchAny?: Array<string> | null; max?: number | null; min?: number | null; startsWith?: string | null; timeZone?: string | null; }> | null; state?: Array<string> | null; target: "text"; type?: string | Array<string> | null; unassigned?: boolean | null; } | { eventStartTimeMax?: string | null; eventStartTimeMin?: string | null; eventTimeZone?: string | null; hasParticipantUris?: Array<string> | null; target: "event"; } | { target: "canvas"; } | { target: "transcript"; } | { target: "call"; } | { invocationIntents?: Array<"action" | "agent-routine" | "capture" | "chat-import" | "document-comments" | "generate" | "mcp" | "meeting" | "proposal-iteration" | "rta-request" | "subagent" | "voice-delegation" | "voice-session"> | null; target: "chat"; } | { target: "artifact"; } | { target: "skill"; } | { includeSystem?: boolean | null; target: "agent"; } | { target: "space"; }> | null; }): Promise<CallToolResult>; };
```

===== mcp__codex_apps__tana_readitems
Access your Tana graph

Read documents by URI. Returns title, content, type, fields, and block structure.

**Task-focused reading — normally pass `task` for substantial documents:** Use `task` both for targeted information-finding and for multi-document synthesis. A fast reader produces a compact, faithful extract from each document before the main agent answers, avoiding large raw bodies in the chat context. Describe the actual end task and required dimensions, for example `task: "Synthesize product decisions, owners, dates, metrics, and unresolved risks across these updates"` or `task: "Each issue's status, assignee, and blocker"`. This is especially important when reading several documents or any large document.

**Omit `task` only when complete source text is required:** rewriting or editing the source, quoting it verbatim, returning its full contents, or reading before the needed details are known. Use `forEditing` for edits. Small documents and structured fields (title, fields, taskProperties) always come back in full even when `task` is set.

**Leftover fields:** Values left behind by a type change, or by a field being removed from the current type, are returned separately as `leftoverFields`, with their original field/type names when available, value, and exact `attributeUri`. They are read-only: never try to update them through `fields`. A request to edit a leftover field is not permission to restore its origin type or recreate a removed field; either action is a separate schema change, so ask the user before doing it. If the current type has a suitable field, update that current field and leave the leftover value unchanged unless the user also asks to clean it up. Leftover values may only be removed with `updateItems.removeLeftoverFields`. For document cleanup, first move each useful value to a suitable field on the current type, or into document content when no suitable field exists; remove the leftover value only after preserving it or when the user wants it discarded.

**Linking in chat replies:** When you reference a document you just read in your chat reply, write it as `[Title](id)` using the `id` field from the result verbatim (it is already the full URI, e.g. `tana:text:abc123` — do NOT prepend `tana:text:` again). The chat client renders this as a clickable chip. Bold or plain text for a known document name is a UX bug. If the user asks to "pull up", "show", or "open" a doc, lead with the link and tell them to click it; there is no inline-open action.

**forEditing=true (recommended before updateItems):**
Returns nested `editableBlocks`: [[id, "text"], [id, "text", [children...]]]

Markdown prefixes indicate block type (include in updateItems content to preserve/change):
- `# ` `## ` `### ` = headings
- `- ` = bullet list item
- `1. ` = ordered list item
- `- [ ] ` / `- [x] ` = unchecked/checked task
- ```lang = code block (```mermaid renders as a diagram; the fence body is the diagram source)

**Block IDs:** All IDs are strings. Container blocks (bulletList, orderedList, blockquote) use prefixed IDs like `"bulletList/xyz"` to mark structural containers.

**Block structure:** Content is in nested paragraph blocks within containers. For editing individual items, target listItem or paragraph IDs. Checkable list items use listItem with a checked attribute. For operations on whole containers, pass the full prefixed ID from readItems directly into updateItems block operation fields.

**TABLE CONTENT:** For documents containing tables:
- Tables appear as type "table" with nested paragraph blocks inside cells
- The paragraph IDs shown are INSIDE cells, not the cell IDs themselves
- Do NOT use blockOperations on table content - use readTable + manipulateTable instead
- readTable returns the actual cell blockIds needed for editing

**Skill documents (tana:skill:...):** Returns title, description, and content body. Supports forEditing=true for block IDs.

**Images (tana:image:...):** Returns cid, dimensions, mimeType instead of content.

**Videos (tana:video:...):** Returns title, filename, mimeType, fileSize, cid, dimensions, duration, thumbnailCid, and (if set) summary/uploadError. The video bytes themselves cannot be read — describe the content to the user by title/metadata, or ask them to clarify. To reference the video in a document, use `![](tana:video:id)` directly; do NOT call readItems just to embed it.

**Audio (tana:audio:...):** Returns title, filename, mimeType, fileSize, cid, duration, and (if set) summary/transcriptUri. The audio bytes themselves cannot be read. If transcriptUri is set, call `readTranscript` (task-aware, preferred) or `readFullTranscript` (raw text) on that URI to get the transcript text — readItems does not read transcript content. To reference the audio in a document, use `![](tana:audio:id)` directly.

**File attachments (tana:asset:...):** Returns filename, mimeType, fileSize, and text content for readable files (markdown, CSV, plain text). Large files may be truncated. Binary files (zip) return metadata only. **For PDF files, use the readPdfContent tool instead** — it uses vision AI to extract text, tables, charts, and diagrams.

**Artifact documents (tana:artifact:...):** Returns `artifactData` with the full artifact JSON (scenes, steps, sections with IDs).
Use `itemIds` to filter to specific items (e.g., ["scene-3"]).

**unsupportedType bucket:** Valid URIs of types readItems can't open (e.g. tana:canvas:, tana:user-profile:) come back in `data.unsupportedType` — treat as "use this URI directly in markdown / attachment slots, don't retry." Distinct from `notFound` (URI tried but doc doesn't resolve).

Use `getItemInfo` when you need metadata such as access, owner, timestamps, proposal state, or graph-index attributes.

**Special ID:** "space:instructions" for AI instructions. This tool is part of plugin `Tana`.

exec tool declaration:
```ts
declare const tools: { mcp__codex_apps__tana_readitems(args: {
  // Return nested editableBlocks with IDs for targeted edits via updateItems
  forEditing?: boolean | null;
  // Document URIs from searchItems, readSkill, or references. Supports tana:text:, tana:skill:, tana:agent:, tana:artifact:, tana:asset:, tana:image:, tana:video:, tana:audio:. Other URI types (e.g. tana:canvas:, tana:user-profile:) come back in `unsupportedType` — use them directly in markdown / attachment slots instead of re-reading.
  ids: Array<string>;
  // For artifact documents: only return data for these specific item IDs (e.g., ['scene-3', 'before-2']).
  itemIds?: Array<string> | null;
  // Filter to blocks matching this text (case-insensitive). Requires forEditing=true
  search?: string | null;
  // When set, each substantial document is read by a fast model that returns a compact, faithful extract for this task instead of the full body. Strongly prefer task when reading multiple or large documents: both for targeted facts (e.g. "each issue's status, assignee, and blocker") and when summarizing or synthesizing across documents (state the dimensions and specifics the synthesis must preserve). Omit task only when the downstream work truly requires the complete source text, such as rewriting, editing, verbatim quotation, or open-ended use whose needed details are not yet known. Ignored when forEditing is set or for media documents; small documents and structured fields are always returned in full.
  task?: string | null;
}): Promise<CallToolResult>; };
```

===== mcp__codex_apps__tana_updateitems
Access your Tana graph

Update items by URI.

⚠️ `id` = item URI (tana:text:..., tana:skill:..., or tana:agent:...) from searchItems/readItems/readSkill. Block IDs belong only in blockOperations.blockId and position fields.

**Choose ONE per item:** `appendContent` (append at end), `blockOperations` (targeted edits), OR `content` (full replacement). Fields/task properties work with any of them.

**appendContent** (safest for append-only updates):
{ "id": "tana:text:...", "appendContent": "## Status

New notes..." }
Use this when adding a section, status update, meeting note, or follow-up to the end of a document. It preserves existing structure and does not require block IDs.

**Mermaid diagrams:** Fenced `mermaid` code blocks render as diagram previews in documents (Preview/Source toggle) and in chat replies. Supported types: graph/flowchart, stateDiagram, sequenceDiagram, classDiagram, erDiagram, xychart — other types (gantt, pie, mindmap, timeline, …) will NOT render; re-express them with a supported type. Prefer a document for diagrams the user will want to keep, edit, or share; inline chat is fine for quick one-off visualizations.

**Block operations** (preferred—use readItems forEditing=true first):
{ "op": "update", "blockId": "id", "content": "New text" }
{ "op": "delete", "blockId": "id" }
{ "op": "insert", "content": "Text", "position": { "relativeTo": "last" } }
{ "op": "insert", "items": ["## Heading", "- Item 1"], "position": { "relativeTo": "id" } }
{ "op": "move", "blockId": "id", "position": { "relativeTo": "otherId", "placement": "before" } }

Container IDs from readItems are strings like `"bulletList/abc123"`. Pass the full prefixed ID directly.

⚠️ **Siblings vs Children:**
- `position.relativeTo` = SIBLING (same level)
- `position.parent` = CHILD (nested under)
To nest under a block: { "position": { "parent": "parentId" } }

**Nested lists:** Items with indentation preserve hierarchy: ["- Parent", "  - Child 1", "  - Child 2"]

**List items:** listItem (empty) → paragraph (has text). Target the PARAGRAPH blockId.

**Block ID chaining:** Insert returns `createdBlockIds` in order for follow-up ops. List inserts return the list container ID before item IDs, so follow-up sibling inserts can anchor after the whole list.

To chain WITHIN one call (the createdBlockIds aren't yet available), tag the first insert with `tempId` and reference it from a later op's position. The tempId resolves to the newest outermost block created by that op, including the list container for list inserts:
```
{"op":"insert", "tempId":"section", "content":"## Related work", "position":{"relativeTo":"<anchor>", "placement":"after"}}
{"op":"insert", "items":["- item 1","- item 2"], "position":{"relativeTo":"#section", "placement":"after"}}
```
Prefer tempId over `relativeTo:"last"` when you mean "right after my previous insert" — `"last"` is ambiguous (the executor will defensively chain it to the previous insert, but tempId makes the intent explicit and supports non-adjacent chains too).

**Embeds:** `![embed](tana:text:id)` creates a document embed. Embeds are BLOCK-LEVEL — they must be inserted as their own block, never placed inline within a heading or paragraph. Use a separate insert operation for each embed.

**Task properties:** state — use UI labels only: Inbox, In Progress, Completed, Later, or a custom workflow state like "Triaged". If the requested state fails, use the available-state list in the error. assignedTo (URIs from "You are:" or Team Members).

**Agent properties:** for `tana:agent:*` URIs only.
- `skills` — replaces the agent's skills list (`tana:skill:*` URIs). Each attached skill's instructions are auto-loaded into every conversation and its allowed-tools become available without calling `readSkill`. Pass `[]` to clear all skills.
- `tools` — replaces the agent's tool list. Tool names must come from the bundles listed in the createAgent description. Pass `[]` to clear all tools.
Both fields are invalid on skill and text docs.

**Type:** Use `type` to assign or change a document's type in place. Use `removeType: true` to make it untyped. Both operations preserve the document, its content, and all stored field values; values not defined by the new type become read-only `leftoverFields`. If changing the type would restore an origin type shown on `leftoverFields`, ask the user first: it reactivates every leftover field from that type. A request to edit one leftover field is not consent to restore the type.

For an existing document, changing to a type owned by another space also requires `targetOwnerUri` in the same update; this explicitly proposes moving the document to that type's home. A pending create is different: changing its type revises where it will be created automatically. Library/top-level types can be used without moving an existing document.

**Fields:** Use exact names from the Types section. References: "[Name](tana:<type>:id)"

**Leftover fields (left behind by a type or schema change):** These are returned separately by readItems as `leftoverFields`. They are read-only and can never be passed through `fields`. Never restore their origin type or recreate a removed field merely to make them editable. If the current type has a suitable or same-named field, update the current field and leave the leftover value unchanged unless the user separately asks to remove it. If no current field fits, explain that the value is read-only and ask whether to migrate it into current content/a current field, remove it, or make an explicit schema change. The only direct operation on a leftover value is removal via `removeLeftoverFields` using the exact `attributeUri` returned by readItems. When cleaning up a document, preserve every useful leftover value first: move it to a suitable field on the current type, or move it into the document content when no suitable field exists. Then remove the leftover field. Do not silently discard values.

**TABLE CONTENT - Special Handling Required:**
- blockOperations CANNOT modify content inside tables
- content field CANNOT replace documents that only contain tables
- For table edits: use readTable to get cell blockIds, then manipulateTable
- Tables are CRDT-safe and require dedicated tools for concurrent editing. This tool is part of plugin `Tana`.

exec tool declaration:
```ts
declare const tools: { mcp__codex_apps__tana_updateitems(args: { autoApprove?: boolean; recap?: string; updates: Array<{ appendContent?: string | null; assignedTo?: Array<string> | null; blockOperations?: Array<{ blockId?: string | null; content?: string | null; items?: Array<string> | null; op: "insert" | "delete" | "move" | "update"; position?: { parent?: string | null; placement?: "before" | "after" | null; relativeTo?: "first" | "last" | string | null; } | null; tempId?: string | null; }> | null; content?: string | null; description?: string | null; fields?: { [key: string]: string | number | boolean | Array<string | number | boolean>; } | null; id: string; removeLeftoverFields?: Array<string> | null; removeType?: boolean | null; skills?: Array<string> | null; state?: string | null; targetOwnerUri?: string | null; title?: string | null; tools?: Array<string> | null; type?: string | null; }>; }): Promise<CallToolResult>; };
```

===== mcp__codex_apps__tana_approveproposals
Access your Tana graph

Approve pending proposals from a session. Approved proposals are applied: creates become visible, updates are merged, deletes take effect. Omit proposalUris to approve all pending proposals.

IMPORTANT: DO NOT call this tool automatically after write operations. After using write tools, you MUST present the proposed changes to the user and wait for their explicit approval before calling this tool. Never auto-approve proposals. This tool is part of plugin `Tana`.

exec tool declaration:
```ts
declare const tools: { mcp__codex_apps__tana_approveproposals(args: {
  // Specific proposal URIs to approve. Omit to approve all pending.
  proposalUris?: Array<string>;
  // Session URI returned by a write tool call
  sessionUri: string;
}): Promise<CallToolResult>; };
```

===== mcp__codex_apps__tana_listproposals
Access your Tana graph

List pending proposals from a session. Returns proposal details including operation type, URIs, and status. Use after write tools to see what changes are pending approval. This tool is part of plugin `Tana`.

exec tool declaration:
```ts
declare const tools: { mcp__codex_apps__tana_listproposals(args: {
  // Session URI returned by a write tool call
  sessionUri: string;
}): Promise<CallToolResult>; };
```

===== mcp__codex_apps__tana_createitems
Access your Tana graph

Create doc items with types, field values, and optional task properties.

IMPORTANT: This tool rejects items whose titles match existing items.
Search first with searchItems to find existing items, then use updateItems to modify them.

The Types section in the system prompt shows available types and their fields. Use those exact field names.
For assignedTo: Your URI is shown as "You are: [Name](uri)" in Context. Teammates are in Team Members. NEVER search for users.

IMPORTANT - Tasks:
- A plain task is an untyped document with a state; use state="In Progress" unless the user requests another state.
- Omit state for untyped documents that are not tasks, such as notes or write-ups.
- NEVER create a type named "Task" - this is a built-in concept.

Parameters:
- "id": Temp ID for referencing this item in other items.
- "content": Body text. Use ![](#id) to embed, [text](#id) to mention other items.
- "fields": Field values. Use [Title](#id) to reference other items created in same call.
- "state": A plain task is an untyped document with a state; use "In Progress" unless the user requests another state. Omit state for untyped documents that are not tasks. Use UI labels only: "Inbox", "In Progress", "Completed", "Later", or a custom workflow state. Typed items default to Inbox when omitted.
- "assignedTo": Only when user explicitly asks to assign someone.

Temp ID syntax:
- Content embeds: ![](#id)
- Content mentions: [text](#id)
- Field references: [Title](#id) (plain #id not supported to avoid hashtag ambiguity)

Image syntax:
- Existing image: ![](tana:image:id) (use URI from chat attachments or readItems)
- From CID: ![alt](cid:contentId) (use CID from readScreenShareScreenshots — auto-creates image document)

Video syntax:
- Attached video: ![](tana:video:id) (use URI from chat attachments). Renders as an inline video player. BLOCK-LEVEL: must be on its own line.

Audio syntax:
- Attached audio: ![](tana:audio:id) (use URI from chat attachments). Renders as an inline audio player. BLOCK-LEVEL: must be on its own line.

File attachment syntax:
- Attached file: ![](tana:asset:id) (use URI from chat attachments or readItems). Renders as a clickable card showing the file's title — use this when the user wants to attach a file to a doc. Do NOT call readPdfContent unless the user explicitly asks to read, summarize, or extract content from the PDF — attaching and reading are different intents. BLOCK-LEVEL: must be on its own line.

Embed syntax:
- Document embed: ![embed](tana:text:id) — embeds are BLOCK-LEVEL, must be on their own line, never inline within headings or paragraphs.

Mermaid diagrams:
- Fenced `mermaid` code blocks render as diagram previews in documents (Preview/Source toggle) and in chat replies.
- Supported types: graph/flowchart, stateDiagram, sequenceDiagram, classDiagram, erDiagram, xychart. Other types (gantt, pie, mindmap, timeline, …) will NOT render — re-express them with a supported type (a flowchart usually works).
- Prefer a document for diagrams the user will want to keep, edit, or share; inline chat is fine for quick one-off visualizations.

Example - Person with Company reference:
{
  "items": [
    { "id": "acme", "title": "Acme Corp", "type": "Company" },
    { "title": "Alice", "type": "Person", "fields": { "Company": "[Acme Corp](#acme)" } }
  ]
}

For reference fields, use [Title](tana:<type>:id) format with URIs from search results.
For options fields, pass one of the values getTypes reports in allowedValues, spelled as it appears there. A value outside that list is rejected rather than stored. This tool is part of plugin `Tana`.

exec tool declaration:
```ts
declare const tools: { mcp__codex_apps__tana_createitems(args: {
  // If true, the server approves the resulting proposals immediately in the same request. Use when the caller has already authorized the write out-of-band (e.g. an explicit user instruction to an AI agent, or a CLI --approve flag). Default false: proposals are created and returned pending review.
  autoApprove?: boolean;
  // Items to create
  items: Array<{
  // User profile URIs. Use URI from 'You are:' in Context, or from Team Members. NEVER search.
  assignedTo?: Array<string> | null;
  // Body content (supports Markdown: ##sub-headers, **bold**, *italic*, `code`, bullets, [links](url), [mentions](tana:<type>:id), ![](tana:image:id) for existing images, ![](tana:video:id) for video attachments, ![](tana:audio:id) for audio attachments, ![](tana:asset:id) for file attachments (PDF, CSV, ZIP, etc. — embeds the file as a clickable card; do NOT call readPdfContent unless the user asked you to read or summarize the contents), ![](cid:contentId) for CID-based images, ![embed](tana:text:id) for document embeds, ```mermaid fenced code blocks render as Mermaid diagrams — supported types: flowchart/graph, sequenceDiagram, stateDiagram, classDiagram, erDiagram, xychart; gantt/pie/mindmap/timeline/gitGraph are NOT supported). Embeds are BLOCK-LEVEL — they must be on their own line, never inline. Do NOT start with a # heading matching the title - the title is stored separately.
  content?: string | null;
  // Field values. For references use [Title](tana:<type>:id) for existing items or [Title](#tempId) for items in same batch. Example: { 'Assignee': '[John](#john)' }. For an options field, name one of its declared values verbatim, NOT as a link: { 'Priority': 'P1' }, or an array for a multi-value one: { 'Affected area': ['Editor', 'Sync'] }.
  fields?: { [key: string]: string | number | boolean | Array<string | number | boolean>; } | null;
  // Temp ID for this item. Reference in content as ![](#id) for embeds or [text](#id) for mentions.
  id?: string | null;
  // Optional owner/target for this item. Only space URIs (tana:space:…) or "top-level" are accepted. Overrides the batch-level ownerUri for this item.
  ownerUri?: string | null;
  // Task/workflow state label. A plain task is an untyped document with a state; use "In Progress" unless the user requests another state. Omit state for untyped documents that are not tasks. Use UI labels only: Inbox, In Progress, Completed, Later, or a custom workflow state. Omit for typed items to default to Inbox.
  state?: string | null;
  // Title of the document
  title: string;
  // Type name (e.g., 'Person', 'Meeting'). Required if providing fields. Never use 'Task' or 'Project' as types.
  type?: string | null;
}>;
  // Optional URI of the space that should own the new doc (its placement). Only space URIs (tana:space:…) are accepted as explicit owners. Use searchItems with `targets: [{ target: 'space' }]` to discover spaces. Pass the string "top-level" to force top-level (no owner). Omit (or pass null) to use the chat's structural owner — that fallback is the right way to place under the current meeting/event.
  ownerUri?: string | null;
  // A short note (1–2 sentences), addressed to the user, recapping what you're proposing and why. Tana shows it as the opening message when the user opens this proposal to review it, so the chat has context to continue from instead of being a bare proposal with no explanation. Describe the subject of the change — the items/content — not the tool or the act of editing. Write it in the user's language.
  recap?: string;
}): Promise<CallToolResult>; };
```
