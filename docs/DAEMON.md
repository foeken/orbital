# DAEMON.md — Tana's events for any agent, and Orbital metadata on any node

The daemon (`daemon/`) is a background process that keeps one Tana connection open and runs an MCP server over it, at
`http://127.0.0.1:23390/mcp` and, through the Tailscale gateway, `https://donut.taila4148b.ts.net/tana/mcp`. It does
two things Tana's own MCP server (home.tana.inc/mcp) does not:

- **Events.** An agent subscribes to Tana's changes ([MCP Events](https://developers.openai.com/plugins/build/mcp-events),
  protocol 2026-07-28) and is called back, signed, as they happen.
- **Metadata.** Two tools, `read_metadata` and `write_metadata`, keep an agent's own JSON keys on a node, in the node's
  `ext:orbital` root and nowhere else.

Everything else (reading content, editing, tasks, meetings) stays with Tana's own MCP server.

## Events

Every event takes a **filter** as its arguments, and the filter is a live query: Tana's server runs it and pushes each
change to its answer over the sync stream (sdk/livequery.js), so nothing polls. Anything Tana can filter on can be
watched. Subscriptions with the same filter share one live query, and the last one to go closes it.

| Event | When | Data |
|---|---|---|
| `tana.node.added` | a node starts to match (made, moved in, retyped, assigned, its state changed into the filter) | `node` |
| `tana.node.changed` | a matching node changed; `fields` in the arguments narrows it to title, state, assignedTo, type, owner, archived or content | `node`, `fields`, `before` |
| `tana.node.removed` | a node stops matching (deleted, moved out, …) | `node` (its id), `last` |
| `tana.task.state_changed` | a matching node's state moved; `from` and `to` narrow it | `node`, `from`, `to` |
| `tana.task.assigned` | someone was assigned to a matching node; `assignee` narrows it to one person | `node`, `assigned` |
| `tana.edge.added` / `tana.edge.removed` | a link appeared or went: a mention, a field reference, a pin, an attendee, a comment, a proposal | `edge` (`from`, `to`, `type`) |

A node filter is any of `uris`, `types` (kinds: text, event, chat …), `ownerUris`, `entityTypeUris`, `stateTypes`
(proposed, open, closed, not_now), `stateWorkflowUris`, `assignedTo`, `createdBy`, `hasParticipantUris`, with
`unassigned`, `includeArchived` and a meeting's start window; at least one list, since an empty filter would be the whole
workspace. A link filter is `edgeTypes` (LINKS_TO, COMMENTS_ON, HAS_PIN …) with a `from` or `to` side. For example,
"tell me when Andre finishes a task": `tana.task.state_changed` with `{ "assignedTo": ["tana:user-profile:…"], "to": ["closed"] }`.

A node in an event is what Tana lists of it (uri, title, kind, type, owner, state, assignees, times); the agent reads
its content through Tana's MCP server. The first answer of a live query is what is there already: it is remembered and
never announced, so an event is always a change. A change the daemon made itself (a metadata write) is not announced
back to it.

**Delivery** is as mcp-server/server.js does it: the callback is challenged before the subscription is taken, every event is
a POST of `{ eventId, name, timestamp, data, cursor: null }` signed with Standard Webhooks (`webhook-id`,
`webhook-timestamp`, `webhook-signature`, `X-MCP-Subscription-Id`), tried again after 2 s, 10 s and a minute, and a
410 ends the subscription. Subscriptions are kept in SQLite and taken up again when the daemon starts; they last what was
asked (an hour to thirty days, a week when nothing was). What happened while the daemon was down is not replayed.

## Metadata

`ext:orbital` is the root Orbital's settings document keeps its keys in (main/settings.js ROOT): one JSON string per key.
The tools read and write that root only, never `data`, `content`, `appearance` or any other root, and they refuse:

- **the settings document itself**, found by its mark (`ext:orbital:doc`), the roots only it has, its `relayKey`, or its
  title (Orbital, Tana Companion): its `ext:orbital` is your settings, the relay key among them;
- **system documents** (user profiles, the org, pin maps, collections, live queries, the inbox): metadata goes on documents
  a person makes;
- keys that are not a letter then up to 63 letters, digits, `_ . -`, values over 8 KB, and more than 200 keys or 64 KB on a node.

Writes apply at once, as the signed-in person; Tana's proposals do not know this root, so there is nothing to approve in
Tana. A write is only reported once Tana has taken it, and one Tana refuses (a node you cannot edit) is reported as such.

This reverses, for the nodes an agent chooses, what main/settings.js keeps apart: a key Tana does not know, on a document
others may see. Whoever can open the node can read its `ext:orbital` over sync, so it is a place for labels, never for
secrets. Tana's own client keeps a root it does not know as it is.

## Signing in

**To Tana**: the daemon has a sign-in of its own, apart from the app's (`~/Library/Application Support/Orbital Daemon`),
so the two never refresh one session against each other. `node daemon/main.js login` opens Tana's sign-in once.

**To the daemon**: a setup key in the Keychain (`orbital-daemon-key`, made by `node daemon/main.js key`, never printed).
A local client (Codex, scripts) sends it as a bearer. ChatGPT, which offers OAuth or nothing, signs in with OAuth 2.1
(dynamic registration, PKCE) and the person approves the connection on `/tana/authorize` by typing that key. Listing the
tools and events needs no sign-in; calling, subscribing and unsubscribing do.

## Running it

| Command | What |
|---|---|
| `node daemon/main.js login` | sign the daemon in to Tana (a window) |
| `node daemon/main.js key` | make the setup key in the Keychain if there is none |
| `node daemon/main.js selftest` | against your Tana: a private scratch note made, its metadata written and read back by a second connection of its own, the settings document refused, the note in the live query and its completion heard as `tana.task.state_changed`, the note deleted |
| `node daemon/main.js` | run the server |
| `sh daemon/install.sh` | install and start the LaunchAgent `com.dreetje.orbital-daemon` from the checkout it is in (the main one: a worktree goes when its PR merges); logs in `~/Library/Logs/orbital-daemon.log` |

All of them are GUI Electron and refuse inside an agent sandbox (docs/ELECTRON-SANDBOX.md). `ORBITAL_DAEMON_PORT`,
`ORBITAL_DAEMON_PUBLIC_URL`, `ORBITAL_DAEMON_USERDATA` and `ORBITAL_DAEMON_DB` move its port, its public address, its
folder and its database. The gateway route is `/tana` in the shared Funnel gateway (local-mcp-tailscale-services):
`/mcp` and the OAuth metadata, registration and token under the OpenAI CIDR guard, `/authorize` public for your browser.

## Checks

`scripts/daemon-check.js` (in `npm run check`) runs it all without Tana: the metadata rules on real Loro documents (no
other root touched, a read writes nothing, the settings document refused five ways), each event from a fake live query,
one live query per filter and closed with its last subscriber, and the whole server over HTTP: the setup key and OAuth,
both tools, a callback challenged, an event delivered with a valid signature, and subscriptions taken up again after a
restart. `selftest` is the same path against the real Tana.

The tools let go of a node's document after each call only when they opened it: `sync.unsubscribe` is not counted, so
letting go of one something else in the process holds would cut that holder off, its writes never reaching Tana (the
first selftest found this: the note it then completed never changed).
