# What a meeting carries (verified read-only, 2026-09-13)

Example: NTP Sync, `tana:event:29jk9nms816j26cmwcq5f9522z`, whose notes document is
`tana:text:01m27y4s6neammpp7ep5c25rta`.

The **event node** is the hub. Its graph node carries `calendarEvent.summary` (the AI summary),
`calendarEvent.tagline` (the "The one where …" title), attendees, organizer, location and the time
window. Its Loro content is empty, as documented in AGENTS.md.

Everything else hangs off the event:

| What | How it is linked | Example |
|------|------------------|---------|
| Notes | a `tana:text:` document whose `ownerUri` is the event, with no task state | "The one where Tana meets NTP" |
| Outcomes | documents owned by the event that do carry a task state | "Create working agreement document with service level expectations" (`proposed`) |
| Pinned | `EDGE_TYPE_HAS_PIN` edges from the event to documents and chats | "Principles", "NTP-ADR-3 …", a chat |
| Recording artefacts | `EDGE_TYPE_BELONGS_TO` edges into the event | `tana:call:`, `tana:transcript:`, `tana:screen-share:`, chats |

`ListEdgesRequest` takes `fromNodeIds` / `toNodeIds` (not source/target) and an `edgeTypes` filter.
The full edge vocabulary is in the descriptors: LINKS_TO, CREATED_IN, BELONGS_TO, ATTRIBUTE_LINKS_TO,
INSTANCE_OF, ASSIGNED_TO, SUBTASK_OF, PART_OF_WORKFLOW, HAS_PROPOSAL, CREATED_BY, EDITED_BY,
UPDATED_IN, USES_AGENT, HAS_PIN, ATTENDEE_OF, ATTENDED, PROPOSES_CHANGE_TO, COMMENTS_ON.

`main.js related(id)` returns `{ summary, tagline, summaryUri, fields[], pinned[], outcomes[], notes[] }` for any
node, so the same call works for documents that pin things or own documents, not only meetings. `fields` is the
zoomed node's own typed fields, not the meeting hub's.
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
