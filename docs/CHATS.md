# What a chat carries (verified read-only, 2026-09-14)

A `tana:chat:<ulid>` document is **not** an outline. It has no `content` tree at all: the conversation lives in
`data.messages`, a LoroList of message maps. That is why `sdk/node.js` initialises no outline for a chat ("native chat
schema has no outline content") and why the app draws a chat from its messages instead (§8).

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
  and titles start with "MCP:". There is no Chats view and no `includeMcp` filter any more (its key could never
  round-trip into a saved search, #247); what hides them is one switch, "Toggle MCP chats" in Cmd+K, stored as the
  `hideMcp` setting, which follows you between machines (docs/SETTINGS.md), and applied in `main/views.js`
  `listFilter` beside the hidden titles — so it covers every
  list and every search (Library, Cmd+K documents, Cmd+S) at once, while a chat opened by id still opens.
- A document written from a chat keeps that chat in `data.createdInUri` (the graph node does not carry it). An MCP client writing with your login is `createdBy` you, so this is the only thing that tells its tasks from yours; new Inbox tasks are announced on it (main/views.js `announceNewInbox`, issue #133).
- `data.participantUris` was empty on every sampled chat; the human author comes from `fromUserUri`, ACL from the
  usual `data.participants`.
- `titleAutoGenerated` appears on chats too, and is `false` on a renamed chat.

## 8. What the app shows when a chat is opened

The rows below are what main hands the renderer; renderer/chat.js draws them as a conversation of bubbles
(docs/OUTLINER.md, Chats), reading `row.chat` on each message row: `mine` (its `fromUserUri` is you), `author`,
`sentAt` and `streaming` (its id is `data.streamingMessageId`). Thinking and status rows carry `note`.

`outline:children` routes a `tana:chat:` id to `chatOutline` (main/documents.js), which reads `data.messages` only when
the chat is opened and hands it to `chatRows` (sdk/chat.js, pure, checked offline by scripts/sdk-check.js). The rows go
through the same `resolveReferences` as a document's outline, so attachment and proposal rows get their target's title,
icon and hue from one `listNodes` batch. Every row is read-only (`editable: false`), and `onChanged(docId)` refreshes an
open chat like any other document.

| Chat piece | Row |
|-----------|-----|
| one message | a top-level heading row: the author's name (from the member list via `fromUserUri`, "Tana AI" for `fromUserType: 'ai'`), the `member` or `chat` icon, the time as meta, "(edited)" when `editedAt` is set |
| message text | child rows, one per markdown block: `#`…`###` headings (deeper ones read as the third), bullets, numbered items, quotes, fenced code (kept verbatim), dividers, and paragraphs of consecutive plain lines. Indentation is dropped, so nested bullets flatten to one level |
| inline markdown | `[label](tana:…)` and date uris become `{ mention }` segments, `[label](https://…)` a link mark; `**`, `*`, `~~` and backticks the bold, italic, strike and code marks |
| `toolCalls` | one progress row first: "Waiting for your input", "Thinking...", "Thought for N seconds" (`completedAt - sentAt`) or "Finished thinking"; a call with `subagentChatUri` becomes a `reference` row to that chat |
| status cancelled, error or limit_exceeded | a status row, "Error: <errorMessage>" |
| `attachmentUris` | `reference` rows |
| `proposals` | a row carrying `proposal` (`proposedUri`, `target` = `baseUri` for an update, `operation`, `metadata`, `state` pending / approved / rejected), drawn as a card in the answer (renderer/chat.js `chatProposalEl`): main adds the target's title and glyph, read with `includeProposals` or from the draft itself, and `approvable` / `reason` from `sdk/proposals.js` `refusal` (main/documents.js `proposalCards`) |
| pending `questionsData` while `askUserQuestion` awaits input | `row.chat.questions` on the message row: the question card in the composer's place (§11) |
| any other status update ("Sam was added to the chat.") | a row with `row.chat.status`: a centred line (§11) |
| `hiddenFromChat`, `type: 'context'`, human `isAIInterviewRelay` messages | skipped |

Segments carry `keep` (the app's own words) and `person` (a name), which demo mode reads (docs/OUTLINER.md).

## 9. How to check this yourself

```bash
node scripts/platform-cli.js chatlist [--owned]
node scripts/platform-cli.js rawdoc tana:chat:01example10000000000000000
node scripts/platform-cli.js rawdoc tana:chat:01example10000000000000000 --containers 1
node scripts/platform-cli.js edges tana:chat:01example10000000000000000
```

`rawdoc` prints every root container (`--containers 1` names each container by kind and keeps text marks, which
`toJSON` drops). `chatlist` exists because `search` has no chat kind (`sdk/query.js searchParams` lists
text, event, user-profile, space and search).


## 10. Sending a message and getting Tana's answer

Read from Tana's web client of 2026-09-27 (ChatPanel, `LoroChatMutations`, the trigger orchestration); sdk/chat.js
`addMessage`, `autoResponds` and `triggerReply` do the same, and main/documents.js `sendChat` runs them in order.

1. **Write the message** (`addHumanMessageWithTimeContext`). The first message you send in a chat on a given local
   day is preceded by a hidden status message, "Robin Vega — it is now Sunday, September 27, 2026 at 11:52 AM
   (Europe/Amsterdam)." (`hiddenFromChat`, `isStatusUpdate`, no `fromUserUri`), and the root map
   `participantTimeContext[you]` becomes `{ timezone, lastLocalDate: 'YYYY-MM-DD' }`; later messages that day go
   without. The message itself is `{ type: 'message', id, sentAt, fromUserUri, fromUserType: 'human', content: { text },
   attachmentUris: [], proposals: [], toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0,
   model: '', cost: 0 } }`, with `id` 8 lowercase alphanumerics. It is an ordinary live update.
2. **Decide whether Tana answers** (its `VKt`, per chat): not when `data.aiAutoResponds` is `false`; when it is
   `true`, while fewer than two people are in the chat; unset, only when exactly one is (people: the keys of
   `data.participants`, else `data.participantUris`). A message that mentions Tana triggers it regardless; Orbital
   counts what Tana's own rule (its `v$`) counts: a link to Tana's agent, `[Tana](tana:agent:…)`, which the composer's
   "@" inserts when you pick Tana, or "@Tana" / "@polaris" in the text.
3. **Ask for the answer**: `POST https://home.tana.inc/api/ai/chat/trigger` (`POLARIS_SERVICE_API_AI_URL` +
   `/chat/trigger`) with the session bearer token and JSON `{ chatUri, ownerUri?, agentId, triggerMessageId,
   timezone }`, answered `{ success: true, messageId }` (the AI message being written) or `{ success: false, error }`
   (`ai_cap_exceeded` when the account's AI allowance is spent). A 404 or 408 means the server has not seen the chat
   yet; the web client retries three times (2, 4, 8 s). `agentId` for a plain chat is Tana's own assistant,
   `tana:agent:` + `createDeterministicId('system:tana')`: the first 16 bytes of the name's SHA‑256 as a ULID
   (`tana:agent:2zc7qjfkkengdhfdd846b4qvk2`); a chat that names its own agent in `data.agentId` sends that one instead, as
   Tana's chat panel does. Orbital keeps a failed trigger apart from the send: the message is already in the chat, so
   `chat:send` answers `{ replyError }` beside it rather than failing, and the composer does not offer it twice. The web client may also send `customContext`, `autoApproveCreates`,
   `model` and coding-tool options; Orbital sends none.
4. **The answer arrives in the document**: the server sets `data.streamingMessageId` (and `streamingLastActivity`),
   appends the AI message and grows its text, then clears the streaming id. Every step reaches Orbital as a live
   update to the open chat.

**To Tana or to the chat.** Orbital's composer sends each message in one of two modes, switched with Tab in an empty
message: To Tana asks Tana to answer whatever the chat's rule says, and To the chat keeps it for the people in the
chat. Such a message carries Tana's own `skipAutoResponse: true` (from its message schema), so no client asks for an
answer to it, and Tana is still asked when the words mention it. The composer starts at the chat's own rule (step 2),
which `chat:answers` reads; `chat:send` takes the mode as `{ ai }`.

**Mentions and skills.** A mention in a message is the markdown link `[label](tana:…)` in its text (§3); Tana's AI reads
the node itself (live: a `[Diagram](tana:skill:…)` mention was answered after a `readSkill` of it). Running a skill is
what Tana's `runSkill` does from a document's Send to menu: a human message whose `attachmentUris` carry the skill (and
there, the document), its text the instruction. Orbital's "/" sends the skill as the message's attachment the same way,
with "Run [skill](uri)" as the text when nothing else is written; `chatsend --attach <uri>` does it from the CLI.

A new chat from Orbital is the kind Tana's own "new chat" makes: a `tana:chat:` with you as its only participant,
no owner, no title and `titleAutoGenerated: true`; the app calls it "New chat" until then (main/rows.js `kindRow`).
Tana's server names an untitled chat after its first answer and leaves a titled one alone: live on 2026-09-27 a chat
created with the title "New chat" kept it, and one created without a title was "Orbital Test Two Math" by the time
the answer had finished. Checked with `node scripts/platform-cli.js chatsend new <text…>` (WRITES), which runs
`chat:new` and `chat:send` and prints the conversation once Tana has answered.


## 11. Answering Tana's questions, and inviting people

Read from Tana's web client of 2026-09-27 (its `useQuestionHandling`, the question mutations and `kxt`); sdk/chat.js
`pendingQuestions`, `answerSummary` and `answerQuestions` do the same, main/documents.js `answerChat` runs them.

- **Waiting.** An AI message is waiting on an answer while its `askUserQuestion` call has `status: 'awaiting_user_input'`
  and `questionsData` is neither `answered` nor `skipped`. Each question is `{ id, question, multiSelect,
  options: [{ label, description }], selectedOptions: LoroList<string>, customAnswer: LoroText }`.
- **Answering** (Submit): each question's `selectedOptions` gets the chosen labels, plus `'__custom__'` when there is a
  free answer, and `customAnswer` the free text; `questionsData` becomes `answered: true, skipped: false, answeredAt,
  answeredByUri`. **Skipping** (Dismiss) sets `skipped: true, answered: false` and the same two stamps.
- **Telling Tana.** Both write one summary: "[User answered AI questions]" and a line per question, `- <first line of
  the question, " […]" when it has more>: <labels joined by ", ">` with `; Custom: <text>` (or `Custom: <text>`
  alone, or `(no selection)`), or for a skip "[User skipped AI questions]" and "Please continue with sensible defaults
  and note assumptions briefly." The summary becomes the waiting call's `output` (`status: 'completed'`,
  `completedAt`) and the text of a new human message with `isAIInterviewRelay: true, excludeFromAIContext: true`,
  which the chat hides; that relay's id is what `/chat/trigger` is then asked to answer (§10).
- Live on 2026-09-27: asked to, Tana put "Pick one: Red or Blue?" in a chat; `node scripts/platform-cli.js chatanswer
  <chat> Blue` answered it, the call completed, and Tana replied "Blue.".

**Inviting.** Tana's chat header shares the chat like any document and then posts
`{ fromUserUri: <the new participant>, fromUserType: 'ai', isStatusUpdate: true }` "<name> was added to the chat.";
when a chat first gets a second participant it also posts "This chat now has multiple participants. Mention @Tana to
trigger AI." (`fromUserType: 'ai'`, status update). Orbital's `chat:invite` does both, the participant added as an
editor through `sdk/access.js setSharing` with everyone already in the chat kept. It only does so for a chat with a
participant list of its own (`restricted: true`); one that takes its audience from its meeting or space would be
narrowed to these people, so it is refused; so is one with a group grant (`type: 'group'`), which the verified sharing
subset does not carry and would drop.

**Status lines.** Tana's chat panel shows every message but `hiddenFromChat` ones and interview relays (its `br`),
status updates included; the app draws one other than "accepted N changes" as a small centred line (`row.chat.status`).


## 12. @Codex: a question in the chat, the answer on this Mac

main/chatagents.js, renderer/chat.js (issue #468). "@" in the composer offers **Codex** after Tana; a message that mentions
it (the chip is written as plain "@Codex") goes through `chatAgent:ask` instead of `chat:send`:

1. **The question is a message to the chat** (`sendChat` with `ai: false`, so `skipAutoResponse` and nobody is asked;
   Tana still answers when the words mention it). Everyone in the chat sees what was asked.
2. **A Codex task on this Mac** is started with main/agent.js `createTask` (the Assign to Agent path, keyed by the chat, so
   its workspace is `agent-workspaces/tana-chat-…`). Its prompt is the question and the whole conversation, oldest first,
   `Name: text` per message, mentions left as `[label](tana:…)` for its Tana tools to read. Its developer instructions
   (`thread/start` `developerInstructions`, `RULES`) say the answer is shown to the asker alone and never saved to Tana,
   to answer only what was asked, and never to write to Tana.
3. **The link stays local**: `chatAsks` (chat → `[{ messageId, agent, taskId, at, state, text, shared }]`) is not in
   main/settings.js `SYNCED`, so it lives in this Mac's SQLite only. Another machine sees the question and nothing else.
4. **The answer is read, never written.** `chatAgent:replies` asks each agent for its running tasks; Codex reads the latest turn of each
   (`thread/turns/list`, `limit: 1`, `itemsView: 'full'`): its `agentMessage` with `phase: 'final_answer'`, or once the
   turn has completed the last one. Read from a second app-server, a turn still running on the one that started it shows
   as `interrupted` with no answer (verified live 2026-09-27: `interrupted` at 3 s, `completed` with the answer at 6 s),
   so only an answer, a completed or failed turn, or `createTask`'s 15-minute cap ends the wait. A finished answer is kept
   in `chatAsks` and not read again.
5. **Drawn on your side**: under the question, a grey bubble headed "Codex · only visible for you, on this device", the
   chat's dots while the task works (read every 4 s while any is running), then the answer. The arrow beside a finished
   answer, or Cmd+K Share Codex’s answer to chat for the latest one, posts it to the chat as your message
   (`chatAgent:share`: `sendChat` with `ai: false`): the only way it reaches Tana. Tana has no author for it but you: a
   message is `human` with a `fromUserUri`, or `ai`, which Tana draws as the chat's own agent (§2), so an `ai` message
   would read as Tana's answer to everyone in the chat. The message it became is kept as `shared` beside the answer, and
   Orbital draws that message on the left under "Codex · shared by you" in place of the grey bubble. Tana, and Orbital
   on another Mac, show it as your message.

The task is kept, not only its answer: clicking the "Codex · …" line over an answer, or Cmd+K Open Codex task for the
latest question, opens it in Codex (`chatAgent:open`: the page names the question, main opens the agent's `url`, for Codex
`codex://threads/<id>`, from `chatAsks`, as the agent badge's `codex:open` does for a node).

A task that cannot start leaves the question sent and says so beside it (`error`), as a failed Tana reply does.

**Another agent** is one entry in `AGENTS` (main/chatagents.js), beside `codex`: its `label` and `icon`, `available()`
(can this device run it; "@" offers only those), `start({ key, prompt, rules })` answering a task id, `read(taskIds)`
answering `taskId → { state, text }` for the ones still running, and `url(taskId)` to open one in its own app. The
question, the prompt, the rules, the local record, the grey bubble, Share and Open are shared, and the page draws every
label from `chatAgent:list`. Codex is the only entry today.

