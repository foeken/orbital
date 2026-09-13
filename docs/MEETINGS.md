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

`main.js related(id)` returns `{ summary, tagline, pinned[], outcomes[], notes[] }` for any node, so
the same call works for documents that pin things or own documents, not only meetings.
`scripts/platform-cli.js edges <id>` dumps both directions for exploring this by hand.
