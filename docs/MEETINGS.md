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

`main/related.js related(id)` returns `{ summary, tagline, call?, summaryUri, fields[], definitions?, pinHub?, hubKind, pinned[], outcomes[], proposals[], notes[], backlinks[], changes[] }`
for any node, so the same call works for documents that pin things or own documents, not only meetings. `fields`
is the zoomed node's own typed fields, not the meeting hub's; `call` is the event's own join link (`{ url, label }`,
the first http(s) url in the calendar location, else `calendarEvent.actionUrl`); `pinHub` is the event or space a
new pin would go to, present only when this user may write it; `hubKind` is the kind of the hub `pinned` was read
from, and `event` puts those pins under the meeting's title (Pinned, after Attendees) instead of the Graph pane.
`scripts/platform-cli.js edges <id>` dumps both directions for exploring this by hand.

## Which document is the summary

There is no summary edge. The write-up is linked to its meeting only by ownership (ownerUri / spaceUri,
which the graph reports as EDGE_TYPE_BELONGS_TO), so it has to be identified by data:

- its title equals the event’s calendarEvent.tagline, which Tana generates together with the document, in
  whatever language the meeting was held (verified on an English and a Dutch meeting);
- it carries the generated appearance.imageUri sketch, which the other owned documents do not.

related() returns it as summaryUri (sdk/events.js `writeUpOf`) using the tagline first and the sketch as a fallback, and never guesses
when neither signal is present. A write-up can be moved out of its meeting into a space, and then the meeting owns
nothing that matches: with a tagline, the document titled exactly that is looked up instead (`writeUpFor`, main/related.js;
the sketch rule stays with owned documents, since any page can carry one). A zoomed meeting used to forward to that document, since an event has no
content of its own; it now stays the meeting, its editor your private notes, and its write-up is the other side of a Notes | Summary switch over them (Private notes, below).

## Private notes: what you type under a meeting (issue #761, verified live 2026-10-05)

A meeting page's editor is your own notes for that meeting. The page stays the meeting's — its title, Visible to (who
sees the meeting), Attendees, the sidebar, ⌘K, Back and Forward — and the rows under it are the whole outline of a
document of yours, its first row included, so every edit there is an edit of that document through the outliner's
ordinary paths (renderer/meetingnotes.js gives the page that document as its body). A line over the rows says who sees
them, so the meeting's own Visible to is never read as theirs: "Your notes · only you can see them" with the lock of
Visible to, or — once you shared them in Tana — "Shared notes" and who: the people's faces, everyone in your
organization, anyone with the link, read only when your grant no longer lets you write; never a lock or "only you"
then. Beside the meeting's title, the Tana glyph opens the meeting itself in Tana (never the notes), "Open in Tana" shown
on hover and keyboard focus; it is there before any notes and makes none. A meeting no longer forwards to its write-up:
a meeting that has one opens on Summary, with Notes | Summary on that line when you have notes for it (or are typing
their first words), and the summary alone when you have none (nothing is drawn until main has said whether there is a
write-up and whether there are notes, so neither the notes nor the switch flash first). Summary puts the write-up's own rows in the notes'
place on the meeting's page, and the line says who sees the write-up and whether you may edit it, read from the
write-up itself (its own metadata and node, asked for it alone, again when it changes live; the line says "Checking" at
once, a row being typed in too, and an older answer never replaces a newer one). It is never inferred from the meeting's
attendees or the notes, and a public link is never drawn with the lock or "only you". Summary never makes notes; what
was typed is saved to the document it was typed in before the other takes its place, a first word's create carries on
under Summary, and Notes puts the caret back where it was. The choice is kept per meeting for the session. The notes' first row, which names the meeting for whoever opens them on their own (in Tana, or in Orbital),
is left out of the meeting's own page while it is exactly the row the seed wrote — its block id, its words, its one
link, nothing under it (main/meeting-notes.js `referenceOf`, renderer/meetingnotes.js `notesRows`); changed, it is
yours and shows.

**Tana has no personal-notes concept.** Its web client (all 149 files of the build served on 2026-10-05) has no key,
kind or rule for them. So the notes are an ordinary `tana:text:` document:

| What | Where | Why |
|------|-------|-----|
| private | `data.restricted: true`, `data.participants` = exactly `{ <you>: { type: 'user', role: 'admin' } }` | a restricted document is its own boundary (Tana's client reads an owner's grants only for an unrestricted one) |
| no public link | no `linkSharing.mode` | Tana writes `setLinkSharing({ mode: 'view' })` to share by link |
| inside the meeting in Tana | **`ownerUri` = the meeting**, and **pinned on it** once (`pinnedItems`, the mark `pinned`), as Tana's own Agenda is; still restricted to you | Tana's meeting page lists what is pinned on a meeting, not what it owns; opened by you alone: a restricted document is its own boundary (below) |
| found again | id `tana:text:` + Tana's `createDeterministicId` of `orbital:meeting-notes:<you>:<event>:<place>` (sdk/chat.js), place 0 to 3 | any machine, any restart, after any rename or lost cache, without a search |
| visible reference in Tana | first row "Open the meeting in Tana", a link to `https://home.tana.inc/o/<org>/e/<event>` (the app's own `webLink`) | followable in Tana's own client; a link adds no edge (below) |
| marked by Orbital | root `ext:orbital:notes`, key `meeting` = the event | Orbital's own root, as the settings document's `ext:orbital:doc` (docs/SETTINGS.md); nothing is added to Tana's `data` |
| named | `data.title` "Private notes · <meeting>" and `createdAt`, written once Tana has confirmed the note | the title only while it is still the seed's, so your own name for it stays |
| confirmed private | root `ext:orbital:notes`, key `confirmed` = you, written with the first words, and only while the note is private at that moment | the proof that a note shared later was made private first (Shared by you, below) |

**Owned by the meeting, private to you (2026-10-05).** The user's rule: "you can connect the notes to the meeting as
long as the notes are only visible to me when I create them; if I opt to share them it's ok", and it has to work on
meetings you were only invited to. So a note is made owned by its meeting, restricted, with your grant alone: Tana
shows it inside the meeting, to you, and reads an owner's grants only for an unrestricted document, so the meeting's
people get nothing from owning it. Notes made before this (owned by nothing) are given to their meeting the next time
the meeting is opened (`adopt`, outside the undo stack as a move is), only while still restricted: an unrestricted
note under the meeting would be open to its people. A note under anything else is not one of these. The meeting's
References in Orbital leave your own notes out (main/related.js, `notesSlotId` in sdk/events.js), since they are its
editor already. Owning is not enough to be seen in Tana: its meeting page lists what is pinned on the meeting
(`EventPins`, over `HAS_PIN`), and a document added in Tana's own meeting page is owned by the meeting and pinned on it
(the Agenda documents on your meetings, read live 2026-10-05). So the notes are pinned there too, once, when found
(`pinOnMeeting`, gated by write access to the meeting, which an attendee has): the mark `pinned` is written after the
pin, so notes you unpin in Tana stay unpinned. The pin is the notes' id in the meeting's `pinnedItems`, which its
people read; it opens nothing. What another attendee's Tana draws for a pin it cannot open is not verified (no second
account). Orbital's own sidebar leaves the pin out as well. Not chosen: an @ mention or `createdInUri`
(`platform-cli notesref`: `LINKS_TO` and `CREATED_IN` edges), which Tana's client does not use to show a meeting's
documents. The first row stays a link to the meeting's page, for whoever opens the notes on their own.

**What is and is not established.** Tana writes a meeting's summary on its servers: its client starts the wrap-up with
`wrapUpJob({ eventUri })` (ActiveCallAutoWrapUp, bundle of 2026-10-05) and nothing else, so which documents that job
reads, and with whose access, cannot be seen from a client; the notes are now in the meeting's graph (`BELONGS_TO`),
which the user accepted. Notes the meeting owns that Orbital did not make — yours in Tana's own client, private or
not — have no mark and are at no place of yours, so they are never this editor and never written from here. Not
established: anything about Tana's servers beyond what they answered — that no
server-side process reads a private document of yours other than on your behalf, and that a second account is refused
(no second account was used; the separation is Tana's ACL as read back, and the offline checks with a second user).
Those hold for these notes as for any private document of yours in Tana; nothing about them is specific to meetings.

**Nothing is written by opening a meeting.** The page asks main (`meeting:privateNotes`, main/meeting-notes.js), which
reads the graph rows of the four places and nothing else: no document is even asked for. The first character typed
asks again with the words. Main uses the first place Tana proves to hold your notes for this meeting — private, or
shared by you since they were confirmed private; otherwise it makes them at the first place Tana lists nothing at, then
asks Tana back before writing a word: the graph row (`restricted`, `participants` only you as admin, `createdBy` you, no
owner, no `linkSharing`, no task state), the owner chain (the note itself the restricted boundary) and the live document
(the same, plus the mark). Only then are the title, the `confirmed` mark and the words written, in one write (one
`mut` and one undo step; the title and mark in one Loro transaction, the words in the next), the words as a row of
their own after the last one.

**How a note is made, safely and once.** The seed — type, the title "Private notes", access, the mark, the reference
row — is the same on every machine, byte for byte: written by a peer that is yours as Tana reads peers (sdk/sync.js
`derivePeerId`: your login's hash above, then 16 bits from the place in 32768–65535, which no machine of yours uses),
with fixed block ids and no clock, title, or anything optional among its inputs (you, the meeting, the place, your
organization's document; anything malformed or missing refuses before anything is made). It is subscribed with
`{ ifMissing: true }` (sdk/sync.js): Tana's first answer for a document this machine has nothing of decides — MISSING
and the seed is written and the note created on the next ask, at once; EXISTING and the document is read as it is,
the seed never written. So the seed never reaches a document that was already there, of anyone's or made any other
way, and two machines making the same new note at once write the same seed, which Loro knows by its operations' ids as
one: both machines' first words land, each as its own row (live: two clients, two peers, one note, both words, one
reference row). Live, Tana confirmed a new note in under 200 ms.

**What is left alone.** A place holding anything else — a note you deleted (the next words go to the next place), a
document someone else holds there, one made by someone else, one shared before it was ever confirmed private (with
someone, by link, opened up), one given an owner, a task, another meeting's — is never written; the next place is used,
and with all four taken no notes are made. Other people's notes on the meeting are never looked for: the places are
derived from you.
Notes of yours at a later place are used before an earlier free one is made into new ones. The meeting's write-up is a
link, never edited from here.

**What fails closed.** Only an answer from Tana lets a place go. No graph row yet, no owner chain, a failed read, or a
document this machine holds only in part (still loading, or empty) is not an answer: the words stay in the row,
nothing new is made, and the page asks again by itself while the row holds words (and on the next keystroke).
Two panes, or a reload, asking at once wait for one answer in main.

**Shared by you.** You may share your notes in Tana as any document of yours (the user's rule: "If someone shares their
notes, it is allowed, just be very clear in the UI under meeting the notes are shared"). They stay the meeting's
editor — the same document, no new one — and the line says "Shared notes" and with whom. Main tells notes you shared
from a note Tana answered as shared before it was ever private by the `confirmed` mark: a create Tana answers as
already shared is refused, never written, and the words go to new private notes at the next place, on every retry.
Notes made before the mark existed count as confirmed by `createdAt` with a write by one of your machines (a peer with
your login's hash and 0–32767 below), which were written only with the first words after the confirmation; the seed
has neither. "Only you" means restricted, your grant the only one (whatever its role) and no public link; a new note
must also hold you as admin before its first word.

Every note main has handed out is checked again at every write to it (`writeGuards` in main/documents.js, which `mut`,
undo/redo and image uploads ask). A change to who sees it or who may write tells every page on the meeting at once
(`outline:changed` with `{ notes: true }`); each turns its line into "Checking who can see your notes…" as it hears
that, and asks again. Shared under a page that said "only you", every write is refused until a page has been told who
sees them now; the page keeps those words and saves them once its line says so (`holdNotesSave`). The hold is per
process, not per pane: the first page told releases it for all, and the others are by then saying "Checking", never
"only you". Moved under an owner or deleted in Tana, they are not this meeting's notes any more and are not written
again; your grant made view-only or taken away makes them read only, by Tana's own rule (sdk/access.js `canWrite`).

**Per account.** Everything is keyed by your user uri, the ids and the seed's peer included: another account never
sees your notes as theirs, never writes to them, and an answer asked under one session is dropped if the account or
the connection changed meanwhile (main checks `S.client`/`S.me` after every wait; the page drops answers from before a
sign-out or a lost connection, older answers for the same meeting, and answers for another account).

**Live proof** (`node scripts/platform-cli.js privatenotes`, escalated; a scratch meeting of yours alone dated in 2020
and its notes, all deleted at the end): opening wrote nothing; the first words made the note at place 0, confirmed in
under 200 ms (graph: owned by the meeting, restricted, one grant, you, admin, created by you, no link sharing; chain:
the note, restricted, then the meeting; Tana's `effectivelyRestricted` true); asking again gave the same note; the
meeting's owned documents list it; two clients making place 2 at once
both kept their words under one reference row; a fresh connection that remembered nothing read the note back — title
"Private notes · <meeting>", the `ext:orbital:notes` mark with `confirmed` you, no Orbital key in `data`, the reference row linking to the
meeting — and found it at its id; with both notes deleted and Tana reporting it (read back, at most 30 s), an open found
none and the next words went to place 1. Each of these is asserted: the command fails if one does not hold. Sharing was not tried live: no real access was changed and no second account was used, so "Shared by you" rests on the offline checks. The offline checks (scripts/sdk-check.js, "meeting notes" and the

**Live proof on a meeting you were only invited to** (`node scripts/platform-cli.js notesinvited`, escalated, 2026-10-05;
a real past meeting, your role `attendee`, someone else organizing, with no notes of yours; both notes deleted at
the end): Tana took the note owned by the meeting, restricted, your grant alone as admin, no link sharing, the chain
the note (restricted) then the meeting, listed among the meeting's documents; an older private note owned by nothing,
given to the meeting as `adopt` does, read back the same; the meeting itself was not written (its version unchanged).
Pinning (`node scripts/platform-cli.js meetingnotes <event>`, which opens a meeting's notes as the app does): on your
notes on a real meeting where you are an attendee, the notes were pinned on the meeting, still restricted to you as
admin alone, and read back so in a fresh session; asked again, nothing more was written.
`ifMissing` lines in the sync checks; scripts/flow-check.js, "type under a meeting") cover the rest with a second user,
a second machine, independent Loro documents and a fake Tana whose graph answers only what it has indexed.

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
- `data.activeSessions`, empty in every call inspected, live or finished, so not a usable signal, and
  `data.callParticipantState`, which holds raised hands;
- `data.transcriptUri` / `data.screenShareUri`, and `wrapUp` timestamps once Tana has summarised the call.

So an entry in `sessions` whose `userUri` is mine is the only server-side proof that I am in a meeting *now*, and
`sessionLog` is the proof that I was in one earlier. Only 48 call documents exist against far more events: no call,
no attendance record. Guests are under the `guestProfiles` root (live on 2026-09-23: a meeting room joined from Teams). `calls.callState` reads
them with the recordings, presented documents, raised hands, reactions and the write-up, and `calls.readTranscript` the
transcript (docs/sdk/02-data-model.md section 5).

`sdk/calls.js` is that read: `callSessions(doc)`, `inCall(doc, userUri)`, `joinedAt(doc, userUri)`, `attended(doc)` and
`currentCalls(client, userUri, { limit = 5 })`, which lists `nodeTypes: ['call']` sorted by update time descending,
subscribes to the few newest, keeps those whose `sessions` contain my user uri and resolves `data.ownerUri` to the
event title in one further query. `scripts/platform-cli.js incall [--limit 5]` is that function from the CLI, and
scripts/sdk-check.js covers it offline. Proven on a live Tana Meet call: joined 08:20:54, reported at 08:25:49.
What it cannot show is whether someone is *participating* rather than idle in the room — speaking would have to come
from the transcript document, and mute or camera state is not in the graph at all.

## Editing a meeting (bundle of 2026-09-23, verified live on a scratch meeting)

Tana's event wrapper writes a meeting's time as `data.startTime`/`data.endTime` (epoch ms, deleting `allDay`), and
its `timezone`, `location` and `description` as plain keys. Its people are the root `attendees` roster, one line per
person keyed `email:<lowercased address>` or `tana:<ulid>` (with `identityUri`), plus an `attendee` participant grant
for an org member. `sdk/events.js` makes those writes. Tana's web client applies one gate to all of them (`Dk`): the
event is unrestricted, or you are an organizer (`admin`/`editor`). Its refusal reads "Only the event organizer can
change this meeting". `Dk` does not look at `origin`: a calendar-synced event (`origin: 'provider'`) is edited like a
Tana-made one (`'tana'`), and the server writes the change back to the calendar and reports it in `data.syncStatus`
(`pending | synced | failed`) and `data.syncError`. Tana's own `updateEvent` tool (`Rwt`) adds two refusals that
Orbital follows as well: a synced event whose calendar copy is not the organizer's (`externalId`, `origin` not
`'tana'`, no `ownerIsOrganizer`) cannot take a change back to the provider, and an all-day event's time cannot be
changed because there is no date-only write path. `access.canEditEvent` is `Dk` plus the first; main/meetings.js
refuses the second.

Live read of six real events (2026-09-23): on a meeting someone else organises I am `attendee` (so `Dk` refuses), on
my own I am `editor` with `ownerIsOrganizer: true`. `ListAttendeeSuggestions` answered 8 people, 7 with a
`tana:user-profile:` `identityUri` and one with an empty one.

Live (`platform-cli meetingedit`, a scratch meeting created and soft-deleted in one run): the gate answered true. The
time, timezone, description and a `tana:` roster line for me came back through the graph. The server also put the
meeting in the Outlook calendar (`externalId`, `calendarSubscriptionUri`, `syncStatus: synced`), so creating a meeting
creates a calendar event. It also replaced a location written right after creation with its Tana Meet link
(`tanaMeetingLinkAppliedAt` 2.4 s after `createdAt`), a race only an edit made in the first seconds can hit. After the
soft delete the document still read `syncStatus: synced`, so whether the Outlook copy is removed was not observed.

## Making a meeting ("/" Meeting, #755)

A meeting made in Orbital is a `tana:event:` laid out as Tana's own create lays one out (sdk/node.js `initDocument`,
kind `meeting`, `origin: 'tana'`), with nobody on its roster and only its maker as a participant. Tana has no meeting
that stays out of the calendar: its server writes a Tana-made meeting into the organizer's own calendar and reports how
that went in `syncStatus`. A read-only survey on 2026-10-05 (counts only, no titles or people) found 3 Tana-made
meetings among the 150 most recently changed events: two with `externalId`, `calendarSubscriptionUri` and `syncStatus:
synced`, one with `syncStatus: failed` and no calendar copy. So a meeting made here usually appears in your own calendar
and may fail to, and the server may add its Tana Meet link to it. Making one invites nobody: invitations follow people
on the roster, who are only ever added with Add attendee …, which says an invite may go out.

"/" Meeting (docs/OUTLINER.md, Toolbar) asks the name and then the time, shows the exact slot before anything is made,
and passes it to `api.createDocument(title, { kind: 'meeting', start, end })`. main/documents.js checks the time before
anything is subscribed (whole epoch ms, a start before an end, on a meeting alone) and writes `startTime`/`endTime` at
birth. ⌘K Create new … Meeting asks its time on the same When page as “/” Meeting (#765). A meeting made with no time (a
meeting's draft, a type for meetings) starts now, to the minute, for half an hour,
in place of initDocument's next half hour, which the phones' engine keeps. The meeting has no write-up until Tana makes one after a call: the row refers to
the event, and opening it forwards to the write-up once there is one (sdk/events.js `writeUpOf`).

In the app, ⌘K on a meeting offers "Change time …", "Change location …" and "Add attendee …" only when
`meeting:info` says it is editable (main/meetings.js, renderer/meeting.js), and on its write-up page too: a zoomed
meeting opens there, and the sidebar's hub (`related().pinHub`) names the meeting. "Change time …" is left out on an
all-day meeting. The time page reads a day in Pin to date's
words and/or a clock time ("tomorrow 9:30", "fri 10:00-11:30"; a start alone keeps the length). The attendee page lists
`GraphService.ListAttendeeSuggestions` first, then org members, leaving out whoever is already on the meeting, and
takes a typed email address. Tana's web client says new attendees get a calendar invite when the organizer's calendar
can write, so the page warns that one may go out.

## Reading a time (Edit meeting details, #758)

⌘K **Edit meeting details** sits beside Change time … on the same meetings (one this user may change, not all-day;
renderer/meeting.js `meetingDetailsRows`). It is one field: the words are read only when ↩ asks
(`api.readMeetingTime(words, id)`, `meeting:read` in main/meetings.js, the model reached through `S.readMeetingTime`, which main/ai.js sets), what they came to is shown as the row to press beside the
meeting as it is, marked "read by AI", and only that press writes it, as a start and an end through `meeting:edit`, the
write Change time makes. Words typed after a reading are read again; a reading that lands after its page was left draws
nothing. "/" Meeting's when page uses the same reading for words it cannot read itself, with no meeting id: a new
meeting starting now for half an hour.

The work is split so that the model never decides anything. main/ai.js `readMeetingTime` asks it, with a strict JSON
schema, to transcribe the words: a day (`YYYY-MM-DD`, worked out from today, which it is told with the time now, the time
zone and the meeting as it is), clock times as written with whether the words fix the hour (am or pm, a 24-hour time such
as 15:00 or 03:00, noon, midnight), a length, a time zone the words name, or a question back when the day or time is
genuinely open ("next week"). The schema has no field for people, places, titles or invitations, and the words are data,
never an instruction. main/meetings.js `resolveTime` then decides what that comes to, the same way every time, in your
time zone (this Mac's) whatever zone the meeting is kept in: someone in Amsterdam who types "tomorrow from 3-5" on a
meeting kept on New York's clock means 15:00 in Amsterdam, and gets it. So:

- a day left out is your today when a time is said (past midnight where you are, that is the new day), and the
  meeting's own day when only its length changes;
- an hour the words leave open is in the day: a bare 1 to 6 is the afternoon, 7 to 11 the morning, 12 noon, so
  "tomorrow from 3-5" is 15:00–17:00 tomorrow; an end left open is the first one after the start ("10-2" is 10:00–14:00);
- an hour the words fix is kept as said (3am, 03:00, midnight), and "until midnight" is the end of that day;
- a length left out is the meeting's own (half an hour for a new one); an end said wins over a length said;
- a zone the words name ("9am New York time") reads their clock times when Intl knows it, and the result says so; one it
  does not know comes back as a question ("Which time zone is …?"), never dropped and never guessed;
- refused, with the reason shown: an answer that is not that shape, a day that does not exist or is more than two years
  away, an end not after its start, no length or a day or more, a time the clocks skip that day (summer time starts);
  nothing is ever carried past midnight but "until midnight".

`meeting:read` refuses before asking the model what `meeting:edit` would refuse (someone else's meeting, an all-day one,
not a meeting). With no ChatGPT sign-in and no API key it says so ("Sign in with ChatGPT or add an OpenAI API key to read
a time"); nothing is guessed in its place. The review row draws the time on your clock, as every time in the app is; a
time read in a zone the words named has that zone's clock under it ("Tokyo time: …"), and a meeting kept in another zone
says so on the page ("Your time · the meeting keeps New York time"; `meeting:info` answers its `timeZone`). Checked
offline: scripts/sdk-check.js (the transcription request, every rule above, a meeting kept in New York read from
Amsterdam, the day past midnight, a named and an unknown zone, the summer-time gap, `meeting:read` refusals),
scripts/renderer-behavior-check.js and the Edit meeting details flow, all on fake answers.
