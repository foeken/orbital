# What a chat carries (verified read-only, 2026-09-14)

A `tana:chat:<ulid>` document is **not** an outline. It has no `content` tree at all: the conversation lives in
`data.messages`, a LoroList of message maps. That is why `outline <chat id>` prints the title and nothing else
today, and why `sdk/node.js` says "native chat schema has no outline content".

Verified by bootstrapping 9 real chats (28 messages) through `begin_document_sync` and cross-checking against the
web client's own declared schema in `https://home.tana.inc/assets/shared-CEMPyt0c.js` (the `Nc.schema({...})` for
chat documents, which lists every field below, including the optional ones no sampled chat used).

Worked example: **"Studio Offsite Goals Extraction"**, `tana:chat:01example10000000000000000`.

## 1. Root containers

| Root | Kind | What |
|------|------|------|
| `data` | LoroMap | title/type/participants as usual, plus `messages` and the `aiContext*` prompt snapshot |
| `invocationContext` | LoroMap | why the chat exists: `intent`, `typeUri`, `typeLabel`, `subjectLabel`, `baseEntityUri`, `triggerUserUri`, `actionUri`, `sourceUtterance`, `sourceStartSec`, `contextUris` (list of `{ uri, mode: 'read' \| 'write-direct' \| 'write-proposal' }`) |
| `participantTimeContext` | LoroMap | user uri → `{ timezone, lastLocalDate }` |
| `proposalForks` | LoroMap | record (empty in every sampled chat) |
| `savedSearches` | LoroMap | record (empty in every sampled chat) |
| `slackSeedCursors` | LoroMap | record (empty in every sampled chat) |

`intent` values (from the bundle enum): `action`, `agent-routine`, `capture`, `chat-import`, `document-comments`,
`generate`, `mcp`, `meeting`, `proposal-iteration`, `rta-request`, `subagent`, `voice-delegation`, `voice-session`.
Seen live: `generate` (with `typeLabel` "Prep"/"Summary"/"Extract meeting outcomes"), `mcp`, `meeting`, `subagent`,
`proposal-iteration`. A plain user chat has `invocationContext` `{}` or absent.

`data` keys beyond the common ones: `messages`, `participantUris` (empty in all samples), `aiAutoResponds`,
`model`, `resultSummary`, `resultStatus` (`ok` | `unresolved`), `streamingMessageId`, `streamingLastActivity`,
`cancellationRequested`, `cancelledMessageId`, `isSubagentChat`, `parentChatUri`, `subagentId`, `agentId`,
`chatType` (`autoSections` | `autoWrapUp` | `agentRoutine` | `voiceSession`), and the prompt snapshot
`aiContextWorkspaceSchema`, `aiContextSpaceInstructions`, `aiContextWorkspaceContext`, `aiContextWorkspaceMembers`,
`aiContextCompany`, `aiContextRenderedSystemPrompt`, `aiContextToolNames`, `aiContextToolsPromptTokens`,
`aiContextContextComposition`, `aiContextCapturedAt`, `aiContextLoadedSkillUris` (all plain strings, several of them
JSON-in-a-string; the system prompt snapshot is why a chat document is large — 2 MB for 8 messages is normal).

One of the nine chats also carried an **empty `content` root map**. The declared schema has no `content` for chats,
so treat it as absent rather than as an outline to render.

## 2. A message

`data.messages` is a plain `LoroList`; **order is list order**. Do not sort by `sentAt`: the synthetic context
message and the first user message share the same millisecond (`1788262342702` in the sample chat).

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | 8 lowercase alphanumerics, like a `blockId` (`0ymc325f`). Graph edges reference it |
| `type` | `'message'` \| `'context'` | every sampled message is `message` |
| `fromUserType` | `'human'` \| `'ai'` | the only author signal on AI messages |
| `fromUserUri` | `tana:user-profile:` | human messages only, and absent on the synthetic preamble |
| `content` | LoroMap `{ text: LoroText }` | see §3 |
| `sentAt` / `completedAt` | ms | `completedAt` only on AI messages |
| `attachmentUris` | LoroList of uri | what the UI shows as document cards |
| `toolCalls` | LoroList | see §4 |
| `proposals` | LoroList | see §5 |
| `usage` | LoroMap | `model` ("gpt-5.6-luna/medium"), `cost`, `promptTokens`, `completionTokens`, `totalTokens`, `cachedInputTokens`, `cacheCreationInputTokens`, `iterationCount`, `providerRequestId`, `triggerSource` ("chat-route"), `durationMs`, `usageByModel` |
| `hiddenFromChat` | bool | the synthetic "Robin Vega — it is now Thursday, September 10, 2026 at 8:50 AM (Europe/Amsterdam)." preamble. Do not render |
| `isStatusUpdate` | bool | the preamble and the "accepted N changes" records |
| `excludeFromAIContext` | bool | set on "accepted N changes" |
| `status` | `'cancelled'` \| `'error'` \| `'limit_exceeded'` | declared, not seen live; with `errorMessage` |
| `questionsData` | LoroMap | declared, not seen live: `{ questions: [{ id, question, multiSelect, options: [{ label, description }], selectedOptions, customAnswer: LoroText }], answered, skipped, answeredAt, answeredByUri }` |
| `anchor` | LoroMap | declared, not seen live: `{ documentUri, kind: 'range'\|'point'\|'span'\|'object'\|'block', startBlockId, startOffset, endBlockId, endOffset, quote, quoteHash, startMs, endMs, x, y, objectId, cid, createdAtVersion }` — this is how document-comment chats point into a document |
| `replyToMessageId`, `reaction`, `resolution` | | declared, not seen live (`resolution`: `resolve` \| `reopen`) |
| `skipAutoResponse`, `isAIInterviewRelay` | bool | declared, not seen live |

### "X accepted 1 change"

Not a special record: it is a **human** message with `isStatusUpdate: true`, `excludeFromAIContext: true`,
`content.text` = `"accepted 1 change"` (or `"accepted 10 changes"`) and `attachmentUris` listing the documents that
were changed. The approval itself is on the *AI* message's proposals (`approvedAt`).

## 3. Message text: markdown in one LoroText, no marks

`content` has exactly one key, `text`, a **LoroText**. Across all 28 messages the delta carried **no mark
attributes at all** — the text is plain markdown source: `##` headings, `-` bullets, `**bold**`, `\n\n` paragraph
breaks, and, crucially, **inline mentions as markdown links**:

```
From [Studio Offsite](tana:event:01example20000000000000000), cross-checked against
[Notes](tana:text:01example30000000000000000) and
[Turning Studio from an entity into a way of working](tana:text:01example40000000000000000):
```

So a mention chip needs no lookup: the label and the node id are both in the link. The uri kind (`text`, `event`,
`skill`, `type`, …) gives the icon the same way the outliner already picks one. This is nothing like a document
outline — there is no prosemirror tree, no `blockId`, no `mention` node.

## 4. Tool calls and "Thought for N seconds"

`toolCalls` is a list of `{ id ('call_…'), name, parameters, output, status, usage, startedAt, completedAt,
providerExecuted, subagentChatUri }`. `parameters` and `output` are **JSON encoded as strings**. `status` is
`running` | `completed` | `failed` | `awaiting_user_input`. Names seen: `readSkill`, `readEvent`, `readItems`,
`readTranscript`, `readFullTranscript`, `readScreenShareScreenshots`, `searchItems`, `getTypes`, `createItems`,
`updateEvent`, `writeMeetingSummary`, `selectOutcomeScreenshots`, `pinItem`, `extractOutcome`.

**No reasoning text is stored anywhere.** "Thought for N seconds" is computed in the client from the message
timestamps; from the bundle:

```js
let S = o && o > a ? o - a : null;          // completedAt - sentAt
A ? (N = S === null ? `Finished thinking` : `Thought for ${XHt(S)}`, P = `completed`)
  : O ? (N = label(O.name, O.parameters, O.output).inProgress, ...)
      : (N = j ? label(j.name, …).completed : `Thinking...`, ...)
```

(`A` = not streaming and every tool call completed.) `usage.durationMs` is close but not identical
(49663 vs 49710 ms on message `1j3cr829`); the label uses `completedAt - sentAt`.

The line only exists on a message with tool calls, and the duration reads "50 seconds", "2 minutes" or "2m 5s"
(`A0t` in the bundle of 2026-09-22); with no duration it is "Finished thinking". A message's `editedAt` adds
"(edited)" to its time.

A tool call with `subagentChatUri` points at a **separate chat document** (`invocationContext.intent: 'subagent'`,
`data.isSubagentChat: true`, `parentChatUri`, `subagentId: 'extractOutcome'`, `ownerUri` = the parent chat). The
web client renders it as a nested chat link.

## 5. Proposals (the change records)

`proposals` is a list of `{ operation: 'create' | 'update' | 'delete', proposedUri, baseUri?, proposedAt,
approvedAt?, rejectedAt?, iterationChatUri?, metadata: { type?, ownerUri?, payload?, intents? } }`.

- `create`: `proposedUri` is the new document (e.g. `tana:text:01example50000000000000000`, "Sample Project Goals —
  Short- and Long-Term"), no `baseUri`.
- `update`: `proposedUri` is a *draft copy*, `baseUri` the real document being changed.
- `iterationChatUri` points at a `proposal-iteration` chat (`data.agentId`, `invocationContext.contextUris:
  [{ uri, mode: 'write-direct' }]`).
- `metadata.intents` is a JSON string, e.g. `[{"type":"reown-embedded-media","family":"media"}]`.
- Every entry, and `metadata` itself, is a real LoroMap in a LoroList (raw container dumps, 2026-09-23); `metadata` is
  written even when empty.

Answering one (Tana's ProposalManager, bundle of 2026-09-23; `sdk/proposals.js` does the create half): approving
stamps `approvedAt` on every pending entry for that `proposedUri`, takes the document out of proposal
(`data.isProposal: false`, `data.createdInUri` = the chat) and posts the "accepted 1 change" message below; rejecting
removes the entries from `proposals` altogether and soft-deletes the proposed document or draft. The graph's chat node
summarises the same list as `chat.proposals` (latest per document, with a `status`) and `pendingCount`, which is how
Tana's own Proposals page and Orbital's list them without opening a chat.

## 6. Graph edges and owner chain

`ListEdges(fromNodeIds: [chatId])` is the authoritative resolution of what a chat references, **per message**:

| Edge | Properties | Meaning |
|------|-----------|---------|
| `EDGE_TYPE_LINKS_TO` | `{ messageId: '1j3cr829' }` | a node mentioned in that message |
| `EDGE_TYPE_HAS_PROPOSAL` | `{ operation: 'create' }` | a proposed document |
| `EDGE_TYPE_CREATED_BY` / `EDGE_TYPE_EDITED_BY` | | author |

Incoming (`toNodeIds: [chatId]`): documents the chat created (`EDGE_TYPE_CREATED_IN`) and subagent /
proposal-iteration chats (`EDGE_TYPE_BELONGS_TO`).

Owner chain behaves like any other document:

- a personal chat is its own boundary: `ownerChain` = itself only, `restricted: true`, audience `only-me`;
- a meeting chat has `data.ownerUri` = the event and inherits `event → space → space`, audience `people`;
- a subagent chat has `ownerUri` = the parent chat, so the chain is `chat → chat → event → space → space`.

Meetings link chats with `EDGE_TYPE_HAS_PIN` and `EDGE_TYPE_BELONGS_TO`, as `docs/MEETINGS.md` describes.

## 7. Gotchas

- **The document is fully readable through the normal `begin_document_sync`.** No separate service, no message
  pagination, no separate transcript/message document kind: every message is inline in `data.messages` (`tana:call:`
  and `tana:transcript:` belong to meetings, not chats). Longest chat sampled: 8 messages. Cost is size, not paging —
  tool `output` strings and `aiContextRenderedSystemPrompt` dominate (2 MB for one 8-message chat).
- **`listNodes({ nodeTypes: ['chat'] })` only returns chats with no owner, unless the request sets `includeOwnedChats: true`** (Tana's AI tools do; its saved-search runner does not), and then it returns every owned one. Live
  on 2026-09-23: 48 without the flag, 417 with it. Of the 369 owned chats, 330 are Tana's background work
  (`proposal-iteration` 124, `generate` 121, `agent-routine` 58, `subagent` 13, `rta-request` 9, and a few
  `capture`, `action` and `voice-delegation`); the other 37 are `meeting` chats ("Private AI chat for …", owned by
  the event). Tana's own chat search (`inspectChats`, bundle of 2026-09-23) keeps a chat whose intent is absent or
  outside its background set `$c`, which is every intent but `meeting`. Orbital adds those meeting chats to every list
  that includes chats and lists the unowned ones as before (MCP chats under their own switch, below):
  `main/views.js` `listFilter` sends a second query, `includeOwnedChats: true` with
  `chatInvocationIntents: ['meeting']` under the list's own filters, and merges it in by update time (after the rest
  when the server ranked by text). It cannot be one query: `chatInvocationIntents` drops every node without that
  intent, other kinds included, and no value matches a chat without one. Adding the flag and filtering afterwards
  does not work either: at a limit of 200 the background chats pushed 26 of the 48 unowned chats and 11 of the 37
  meeting chats out. A list with a state filter skips the second query, since a chat has no state.
- MCP chats are a single AI message plus an "accepted N changes" status message; `invocationContext.intent: 'mcp'`
  and titles start with "MCP:". The Chats view's `includeMcp` filter is still gone (its key could never round-trip
  into a saved search, #247); what hides them now is one app-local switch, "Toggle MCP chats" in Cmd+K, stored as
  the `hideMcp` setting and applied in `main/views.js` `listFilter` beside the hidden titles — so it covers every
  list and every search (Library, Cmd+K documents, Cmd+S) at once, while a chat opened by id still opens.
- `data.participantUris` was empty on every sampled chat; the human author comes from `fromUserUri`, ACL from the
  usual `data.participants`.
- `titleAutoGenerated` appears on chats too, and is `false` on a renamed chat.

## 8. What the renderer should show when zoomed into a chat

Messages map onto existing outliner concepts (`docs/OUTLINER.md` Addendum 1), so nothing new is needed in the CRDT
layer and no chat row is ever editable (`Node.editable === false` throughout).

| Chat piece | Existing row concept |
|-----------|----------------------|
| one message | a top-level non-editable row: bullet = author (member icon/avatar via `fromUserUri`, the `chat` glyph for `fromUserType: 'ai'`), label = author name + time |
| message text | child rows, one per markdown block: `##` → `heading`, `-` → plain rows, everything else a paragraph row |
| `[label](tana:…)` in the text | `segments: [{ mention: { label, uri } }]` — already rendered as a clickable link that zooms |
| `attachmentUris` | `type: 'reference'` rows (`reference: { uri }`), which `outlineWithReferences` already resolves to a title/icon card |
| `proposals` | `reference` rows to `proposedUri` (or `baseUri` for an update) with a chip: approved / awaiting approval |
| `toolCalls` | one progress row per AI message: "Thinking...", "Waiting for your input", or "Thought for Ns" from `completedAt - sentAt`; `subagentChatUri` becomes a `reference` row to that chat |
| status is cancelled, error, or limit_exceeded | a read-only status row; `errorMessage` follows the "Error" label |
| pending `questionsData` while `askUserQuestion` awaits input | one read-only heading per question, with its options as child rows |
| `hiddenFromChat: true` | skip |
| "accepted N changes" | a muted status row plus its `attachmentUris` references; every other status update is hidden, as are human messages with `isAIInterviewRelay` |

Chat status and pending-question rows use the same read-only outline model as the rest of the conversation.

Main process work needed:

1. a chat reader beside `readOutline` that turns `data.messages` into those rows (markdown → blocks/segments is the
   only new parsing; the `[label](uri)` regex is the whole mention story);
2. the zoom/children path must route `tana:chat:` ids to it instead of `readOutline` (today `readOutline` returns
   `[]`, which is exactly the empty page);
3. references need the existing `nodeIds` `listNodes` lookup for attachment/proposal titles, icons and hue — the
   same one `outlineWithReferences` and the node-hue cache already do;
4. nothing else: `onChanged(docId)` already refreshes a subscribed chat, and every row is read-only.

## 9. How to check this yourself

```bash
node scripts/platform-cli.js chatlist [--owned]
node scripts/platform-cli.js rawdoc tana:chat:01example10000000000000000
node scripts/platform-cli.js rawdoc tana:chat:01example10000000000000000 --containers 1
node scripts/platform-cli.js edges tana:chat:01example10000000000000000
```

`rawdoc` prints every root container (`--containers 1` names each container by kind and keeps text marks, which
`toJSON` drops). `chatlist` exists because `search` has no chat kind (`sdk/query.js searchParams` lists
text/event/user-profile only).
