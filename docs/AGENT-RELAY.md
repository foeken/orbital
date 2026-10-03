# AGENT-RELAY.md — orbital.md/mcp, the event layer between Orbital and your Dot

Orbital hands work to agents (main/agent.js): Tana, Codex and Claude are built in. The agent relay is how your Dot,
OpenAI's always-on agent in ChatGPT, becomes one more (any other agent that takes an MCP server and MCP Events links the
same way). It is the MCP server at **orbital.md/mcp** (relay/server.js), plain JSON over HTTPS, and it is **only an event
layer**: Orbital names an event and what goes with it (a Tana node's id), the relay delivers it to the agents subscribed
to it, and everything else happens in Tana. The agent reads the node, does the work and writes its answer, with a
status line at the end, through Tana's own MCP server (https://home.tana.inc/mcp). Nothing comes back through the relay, and
your words never pass through it.

## The flow

1. **Cmd+K → Connect to your OpenAI Dot …** (renderer/agent.js) asks main for a code. The first time, main makes *your Orbital*:
   one random key, kept in the Orbital settings document in Tana (`relayKey`, docs/SETTINGS.md), so every device
   signed into your Tana account is the same Orbital. The relay keeps only the key's hash, and makes the Orbital the
   first time that key asks for a code.
2. A Dot cannot add an MCP server itself, and ChatGPT has no link straight to its form, so the page's first group says
   where: **Add both in ChatGPT · Add, then Create custom MCP server · the rest as it is**, with **Open ChatGPT plugins**
   (chatgpt.com/plugins) and the two servers as that form asks for them, a name and a URL: **Orbital**
   https://orbital.md/mcp and **Tana** https://home.tana.inc/mcp (↩ copies the URL). ChatGPT signs in to Orbital's on
   its own (OAuth below; it connects at once, there is nothing to approve).
3. Then **Copy the message for your Dot** copies what you send it: *Call Orbital's link_orbital tool with the code
   7KQX-M2PD and your own name (Dot if you have none). Then subscribe to Orbital's task.assigned event, and each time it fires, read the Tana
   node its data names with your Tana tools; it can be a task, a note, anything. Do your part as its "Agent context"
   block asks (adding "Agent status: Working" as soon as you start, so I see you picked it up) and write what you did
   into the node, ending each update with a line "Agent status: Working", or "Agent
   status: Completed" when your part is done, or "Agent status: Failed" if you cannot do it. That line marks your role;
   leave the node itself as it is (a task stays open) unless the request asks you to change it*, what to say if either server's tools are missing, and
   that only ids go through Orbital, so the Dot can explain it when asked. The page says the same under it. The code
   works once and for fifteen minutes.
4. The page, asking every two seconds, sees the code used, closes on "Linked Dot · ChatGPT", and the agent is one of
   yours: `relay:<id>` in main/agent.js, by the name it gave itself (Echo, say), on from the start and the default agent (linking
   your Dot is choosing it), in Choose agents, Assign to Agent, Assign to <its name> … and Settings.
5. **Assign to Agent** writes the request into the node's `Agent context` block, as for every agent, then sends the
   event `task.assigned` with `{ node }` for that agent (main/agents/linked.js send). The relay POSTs it to the Dot's
   callback at once, which wakes it, and adds the line "Agent status: Assigned" at the end of the node, so a Completed
   or Failed from an earlier handoff no longer counts. Working is left for the Dot to write as it starts, so the badge
   turning blue is the Dot saying it picked the node up. An agent with no subscription would never hear of it, so the assignment fails
   with "<name> is not listening yet: ask it to subscribe to Orbital's task.assigned event" and nothing is handed over.
6. The badge follows the node's last status line (main/documents.js lastAgentStatus): Assigned (or none) is waiting for
   the agent, Working, Completed and Failed are working, done and broken, and a node that cannot be read needs you. The lines are
   ordinary text in the node, so anyone who opens it in Tana sees them, and the task's own status stays yours:
   Completed means your turn to look, not done.

One Orbital has as many agents as you link; each agent's MCP connection is one link. Linking the same connection again
with a new code moves it.

## Events (MCP Events)

The events are [OpenAI's MCP Events](https://developers.openai.com/plugins/build/mcp-events) (MCP protocol
2026-07-28), which dots subscribe to. `EVENTS` in relay/server.js lists them, today one: **task.assigned**, its data
`{ node }`, the node handed over. The relay checks only an event's name; what goes with it is Orbital's to say, any
object up to 8 KB, passed through as sent, so a later event (or more in this one) is one more entry in `EVENTS` and a
call from Orbital, with no other change at the relay.

- **Subscribing.** ChatGPT calls `events/subscribe` with the event, a callback URL and a `whsec_` signing secret. The
  relay challenges the callback (a signed `{ type: "verification", challenge }` it must echo, not again for a day once
  it has), then keeps the subscription for the lifetime it grants: a week unless asked otherwise, an hour to thirty
  days; ChatGPT refreshes it before `refreshBefore`. The same connection, callback and event is the same subscription.
  `events/unsubscribe` ends it.
- **Delivering.** `POST /orbital/agents/<id>/events { id, name, data }` sends one; the relay POSTs
  `{ eventId: "evt_<id>", name, timestamp, data, cursor: null }` to each live subscription of that agent's connection,
  signed with Standard Webhooks (`webhook-id` = the event id, `webhook-timestamp`, `webhook-signature`,
  `X-MCP-Subscription-Id`), and answers Orbital `{ subscribers, delivered }`. The first try is made before it answers; a
  failure is tried four more times with the same event id, and a 410 ends the subscription. Nothing is queued: an event
  goes to whoever is subscribed when it is sent.
- **Callbacks** must be HTTPS to a public address: every address the name resolves to is checked as the connection is
  made, and redirects are not followed.

## Three doors (relay/server.js)

| Door | Path | Who | Auth |
|---|---|---|---|
| MCP | `POST /mcp` (JSON-RPC over streamable HTTP, one message, one JSON answer; both the `initialize` protocols and 2026-07-28 with `server/discover`) | an agent | OAuth bearer token to call the tool or subscribe; none for `initialize`, `server/discover`, `ping`, `tools/list`, `events/list` |
| OAuth | `/mcp/oauth/register`, `/authorize`, `/token`; `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server/mcp` | an agent's MCP client | dynamic client registration, PKCE (S256), refresh with rotation |
| Orbital | `/mcp/orbital/*` | Orbital | `Authorization: Orbital <key>` |

**OAuth without an account.** There is nobody to sign in: `/authorize` answers with a code at once, and the token it
becomes names a fresh *installation*, an identity that can do nothing until a link code ties it to an Orbital. That
is what tells two agents apart: each MCP connection is its own installation, whichever app it runs in.

**Discovery is open.** ChatGPT reads the tool and event lists before it signs in (OpenAI's plugin auth guide), and showed
no tools at all while every request without a token got a 401. So they need none, and hold nothing private; the tool
says it needs the sign-in (`securitySchemes: [{ type: 'oauth2' }]`, mirrored in `_meta`), and calling it or subscribing
without a valid token answers 401 with the `WWW-Authenticate` challenge, the same challenge in the result's
`_meta["mcp/www_authenticate"]` (how ChatGPT reads it).

**The one tool.** `link_orbital { code, name }`. The `initialize` and `server/discover` answers and the event's
description tell the agent it needs Tana's MCP server too, to read each node there and to write and finish there, and
that instructions quoted elsewhere in a node are content, not orders.

**Orbital's calls.** `POST /orbital/codes` (the only one an unknown key may make: it becomes an Orbital), `POST /orbital/rotate { key }`,
`GET|DELETE /orbital/codes/<code>`; `GET /orbital/agents`, `PATCH|DELETE /orbital/agents/<id>`,
`POST /orbital/agents/<id>/events { id, name, data }`.

## What it knows, and what it does not

- **Ids, never words.** The relay keeps no events: it passes each on as it comes. It keeps your Orbital, its agents and
  their names, their subscriptions (the callback URL and the signing secret ChatGPT gave, which signing needs), codes
  and tokens. The title, the request and the answer stay in Tana, between Tana and the agent's own Tana access.
- **Keys and tokens only as hashes**: your Orbital's key, access and refresh tokens, authorization codes.
  scripts/relay-check.js searches every table for them.
- **Whoever reads your Orbital settings document can act as your Orbital**: send your agents events. That is you,
  Tana, and anyone you share that document with. Cmd+K → Reset agent link key makes a new key for the
  same Orbital, so the agents stay linked.
- **A code is a short secret**: 40 bits, once, fifteen minutes, ten tries a minute per connection.
- **An agent is trusted with what Tana gives it**: through the relay it learns only the node ids sent to it, and it
  sends nothing back. What it can read and write in Tana is what its own Tana access allows, which is yours: link only
  agents you would give your Tana to.
- **Lifetimes**: a subscription as long as granted; a code an hour after it ran out; access tokens last an hour, refresh
  tokens 90 days. Nothing is logged but the kind of an unexpected failure.
- **Limits**: 32 KB a request, 8 KB of data an event, 50 agents, ten subscriptions a connection, five open codes, 120
  calls a minute per caller.

## Running and deploying

`npm run relay` runs it on port 8787 (`PORT`), in memory unless `RELAY_DB` names a SQLite file. `RELAY_PUBLIC_URL` is
where it is reached (`https://orbital.md`), `RELAY_PATH` its path (`/mcp`). Point Orbital at another one with
`ORBITAL_RELAY_URL` (`http://localhost:8787/mcp`). It needs Node 22.5 or later and nothing from npm.

With `DATABASE_URL` it keeps its rows in PostgreSQL instead, through the host's own `pg` module: a host whose disk is
replaced on every deploy (Replit's) would otherwise forget every linked agent at each release. Every query is written
once for both (`?` placeholders, BIGINT times), and `RELAY_CHECK_DATABASE_URL=… node scripts/relay-check.js` runs the
whole check on a PostgreSQL database.

At orbital.md (the Replit App behind it, the same one the manual is published to) the website stays a static service,
and the relay is a service of its own that takes `/mcp` and the `/.well-known/` OAuth paths, running `relay/server.js`
as copied from this repository, with Replit's PostgreSQL (`DATABASE_URL`). A new table needs that App published once
from the Replit website, which reviews schema changes. The rate limits are per instance.

