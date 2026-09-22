# What a meeting carries (verified read-only, 2026-09-13)

Example: Platform Sync, `tana:event:01example60000000000000000`, whose notes document is
`tana:text:01example70000000000000000`.

The **event node** is the hub. Its graph node carries `calendarEvent.summary` (the AI summary),
`calendarEvent.tagline` (the "The one where …" title), attendees, organizer, location and the time
window. Its Loro content is empty, as documented in AGENTS.md.

Everything else hangs off the event:

| What | How it is linked | Example |
|------|------------------|---------|
| Notes | a `tana:text:` document whose `ownerUri` is the event, with no task state | "The one where Tana meets the team" |
| Outcomes | documents owned by the event that do carry a task state | "Create working agreement document with service level expectations" (`proposed`) |
| Pinned | `EDGE_TYPE_HAS_PIN` edges from the event to documents and chats | "Principles", "ADR-3 …", a chat |
| Recording artefacts | `EDGE_TYPE_BELONGS_TO` edges into the event | `tana:call:`, `tana:transcript:`, `tana:screen-share:`, chats |

`ListEdgesRequest` takes `fromNodeIds` / `toNodeIds` (not source/target) and an `edgeTypes` filter.
The full edge vocabulary is in the descriptors: LINKS_TO, CREATED_IN, BELONGS_TO, ATTRIBUTE_LINKS_TO,
INSTANCE_OF, ASSIGNED_TO, SUBTASK_OF, PART_OF_WORKFLOW, HAS_PROPOSAL, CREATED_BY, EDITED_BY,
UPDATED_IN, USES_AGENT, HAS_PIN, ATTENDEE_OF, ATTENDED, PROPOSES_CHANGE_TO, COMMENTS_ON.

`main/related.js related(id)` returns `{ summary, tagline, call?, summaryUri, fields[], pinHub?, pinned[], outcomes[], notes[], backlinks[], changes[] }`
for any node, so the same call works for documents that pin things or own documents, not only meetings. `fields`
is the zoomed node's own typed fields, not the meeting hub's; `call` is the event's own join link (`{ url, label }`,
the first http(s) url in the calendar location, else `calendarEvent.actionUrl`); `pinHub` is the event or space a
new pin would go to, present only when this user may write it.
`scripts/platform-cli.js edges <id>` dumps both directions for exploring this by hand.

## Which document is the summary

There is no summary edge. The write-up is linked to its meeting only by ownership (ownerUri / spaceUri,
which the graph reports as EDGE_TYPE_BELONGS_TO), so it has to be identified by data:

- its title equals the event’s calendarEvent.tagline, which Tana generates together with the document, in
  whatever language the meeting was held (verified on an English and a Dutch meeting);
- it carries the generated appearance.imageUri sketch, which the other owned documents do not.

related() returns it as summaryUri using the tagline first and the sketch as a fallback, and never guesses
when neither signal is present. The renderer forwards a zoomed meeting to that document, since an event has no
content of its own.

## Typed fields

A field value is a ProseMirror-style tree in the document own data map under the key
"<type uri>?attribute=<key>": { nodeName: doc, children: [{ nodeName: paragraph, attributes: { blockId },
children: [text] }] }. The field name comes from the type document template.attributes ([{ key, title, type,
cardinality, to }]); the graph node typeDef carries the same data but is not always readable, so the SDK reads the
type document instead. sdk/fields.js reads and writes these values, and main exposes them through related() and
doc:setField.

## Who is in the meeting right now (verified live, 2026-09-18)

The event node answers *invited* and *scheduled*, never *attending*. `calendarEvent.attendees` and the newer
`calendarEvent.roster` (`lineKey`, `email`, `displayName`, `identityUri`, `source`, `role`, `responseStatus`) are the
calendar’s guest list: a roster entry with `responseStatus: accepted` means the invitation was accepted, and it reads
the same an hour before the meeting as an hour after. `calendarEvent.mode` was empty on every event looked at.

Attendance lives one document further out. A call creates a `tana:call:` document with **the same ULID as its event**
and `data.ownerUri` pointing back at it (the `EDGE_TYPE_BELONGS_TO` edge in the table above). It carries:

- a `sessions` **root** map, one entry per live session, keyed `<user-profile uri>:<8 hex>` with `{ joinedAt, userUri }`. Keys starting with `federation:` are another organization's capture of the meeting; the web client leaves them out of `activeParticipantUris`, and so does `calls.js`. `sessionLog` entries are `{ userUri, event, timestamp, sessionId }`.
  It empties when the last participant leaves — a finished call reads `sessions: {}`;
- `data.sessionLog`, the append-only history: `{ userUri, timestamp, event: "join" | "leave" }`;
- `data.activeSessions` and `data.callParticipantState`, empty in every call inspected, live or finished, so neither
  is a usable signal;
- `data.transcriptUri` / `data.screenShareUri`, and `wrapUp` timestamps once Tana has summarised the call.

So an entry in `sessions` whose `userUri` is mine is the only server-side proof that I am in a meeting *now*, and
`sessionLog` is the proof that I was in one earlier. Only 48 call documents exist against far more events: no call,
no attendance record. Guests would appear under the `guestProfiles` root, which was empty here.

`sdk/calls.js` is that read: `callSessions(doc)`, `inCall(doc, userUri)`, `joinedAt(doc, userUri)`, `attended(doc)` and
`currentCalls(client, userUri, { limit = 5 })`, which lists `nodeTypes: ['call']` sorted by update time descending,
subscribes to the few newest, keeps those whose `sessions` contain my user uri and resolves `data.ownerUri` to the
event title in one further query. `scripts/platform-cli.js incall [--limit 5]` is that function from the CLI, and
scripts/sdk-check.js covers it offline. Proven on a live Tana Meet call: joined 08:20:54, reported at 08:25:49.
What it cannot show is whether someone is *participating* rather than idle in the room — speaking would have to come
from the transcript document, and mute or camera state is not in the graph at all.
