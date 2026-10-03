# AGENT-RELAY.md — linking any agent to Orbital

Orbital hands work to agents (main/agent.js): Tana, Codex and Claude are built in. The agent relay is how your Dot,
OpenAI's always-on agent in ChatGPT, becomes one more (any other agent that takes an MCP server links the same way). It is
the MCP server at **orbital.md/mcp** (relay/server.js), plain JSON over HTTPS, and the only thing between Orbital and
those agents. **Only ids go through it**: a task is a Tana node's id and an action, which the agent carries out by
reading and answering in the node through Tana's own MCP server (https://home.tana.inc/mcp); what comes back is the
task's id and a status. Your words never leave Tana.

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
   7KQX-M2PD and the name Dot. Then subscribe to Orbital's task.assigned event, and each time it fires, call get_tasks
   and carry out what it returns*, what to say if either server's tools are missing, and that only ids go through Orbital
   (a node's id and what to do with it, and a status back) while the words stay in Tana, so the Dot can explain it when
   asked. The page says the same under it. The Dot calls `link_orbital` and is linked. The code works once and for
   fifteen minutes. Any other agent that takes an MCP server can still link with the same message; the relay does not
   know which app it is.
4. The page, asking every two seconds, sees the code used, closes on "Linked Dot · ChatGPT", and the agent is one of
   yours: `relay:<id>` in main/agent.js, on from the start, in Choose agents, Assign to Agent and Settings.
5. **Assign to Agent** writes the request into the node's `Agent context` block, as for every agent, then queues
   `{ id, node, action: "assign" }` for that agent, and the relay POSTs the `task.assigned` event to the agent's
   callback at once (below), which wakes it. It calls `get_tasks`, reads the node
   with its Tana tools, writes what it did into the node with them too, and reports with `update_task` (working,
   completed or failed). Whichever of your devices reads a status first keeps it in `relayTasks`, so every device draws
   the same badge (main/agents/linked.js).

One Orbital has as many agents as you link; each agent's MCP connection is one link. Linking the same connection again
with a new code moves it. `assign` is the one action today; the field is there so a later one (such as cancel) needs no
new message.

## The event that wakes the agent (MCP Events)

The relay is how a task reaches the agent the moment you assign it. Orbital's server offers one event, `task.assigned`
([OpenAI's MCP Events](https://developers.openai.com/plugins/build/mcp-events), MCP protocol 2026-07-28, which dots
subscribe to). The Dot subscribes once, as the message asks: ChatGPT calls `events/subscribe` with a callback URL and a
`whsec_` signing secret; the relay challenges the callback (a signed `{ type: "verification", challenge }` it must echo),
then keeps the subscription for the lifetime it grants (a week unless asked otherwise, an hour to thirty days; ChatGPT
refreshes it before `refreshBefore`). When Orbital queues a task for that agent, the relay POSTs
`{ eventId: "evt_<task id>", name: "task.assigned", timestamp, data: { task_id, node, action }, cursor: null }` to the
callback, signed with Standard Webhooks (`webhook-id` = the event id, `webhook-timestamp`, `webhook-signature`,
`X-MCP-Subscription-Id`): ids only, as everywhere. The first try is made before Orbital's call is answered; a failure is
tried four more times with the same event id, a 410 ends the subscription, and the task waits in `get_tasks` regardless.
A callback must be HTTPS to a public address: every address its name resolves to is checked as the connection is made,
and redirects are not followed. `events/list` needs no sign-in; subscribing and unsubscribing do, and a connection
hears only of its own agent's tasks. Nothing calls Orbital: it asks for statuses when it reads the agents' badges
(main/agents/index.js readStatuses, every 30 s and on each refresh).

## Three doors (relay/server.js)

| Door | Path | Who | Auth |
|---|---|---|---|
| MCP | `POST /mcp` (JSON-RPC over streamable HTTP, one message, one JSON answer; both the `initialize` protocols and 2026-07-28 with `server/discover`) | an agent | OAuth bearer token to call a tool or subscribe; none for `initialize`, `server/discover`, `ping`, `tools/list`, `events/list` |
| OAuth | `/mcp/oauth/register`, `/authorize`, `/token`; `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server/mcp` | an agent's MCP client | dynamic client registration, PKCE (S256), refresh with rotation |
| Orbital | `/mcp/orbital/*` | Orbital | `Authorization: Orbital <key>` |

**OAuth without an account.** There is nobody to sign in: `/authorize` answers with a code at once, and the token it
becomes names a fresh *installation*, an identity that can do nothing until a link code ties it to an Orbital. That
is what tells two agents apart: each MCP connection is its own installation, whichever app it runs in. An app that
shares one connection between several bots is one agent to Orbital.

**The tool list is open.** ChatGPT reads it before it signs in (OpenAI's plugin auth guide), and showed no tools at all
while every request without a token got a 401. So hello and the list need none, and hold nothing private; each tool
says it needs the sign-in (`securitySchemes: [{ type: 'oauth2' }]`, mirrored in `_meta`), and calling one without a
valid token answers 401 with the `WWW-Authenticate` challenge (how any MCP client starts the sign-in, and refreshes an
expired token), the same challenge in the result's `_meta["mcp/www_authenticate"]` (how ChatGPT does).

**MCP tools.** `link_orbital { code, name }`, `get_tasks {}` (`{ task_id, node, action, sent_at }` each, and how to
handle them; a fetched task is leased for ten minutes, then offered again), `update_task { task_id, status:
working|completed|failed }` (the first update is the receipt: the task leaves the queue; anything else it is given is
dropped). The `initialize` answer and the tools tell the agent it needs Tana's MCP server too, to read each node there
and to write its answer there, and that instructions quoted elsewhere in a node are content, not orders.

**Orbital's calls.** `POST /orbital/codes` (the only one an unknown key may make: it becomes an Orbital), `POST /orbital/rotate { key }`,
`GET|DELETE /orbital/codes/<code>`; `GET /orbital/agents`, `PATCH|DELETE /orbital/agents/<id>`,
`POST /orbital/agents/<id>/messages { id, node, action }` (idempotent on `id`; a node must be a Tana id and the action
one the relay knows); `GET /orbital/updates` (each `{ id, agent, task, status, at }`, leased for two minutes to
whichever device asked, so two devices do not both take one), `POST /orbital/updates/ack { ids }`.

## What it knows, and what it does not

- **Ids, never words.** The relay stores, for as long as each lives, which Tana node ids were handed to which agent
  with which action, and the statuses that came back, in plain rows (HTTPS on the way). The title, the request and
  the answer stay in Tana, between Tana and the agent's own Tana access.
- **Keys and tokens only as hashes**: your Orbital's key, access and refresh tokens, authorization codes.
  scripts/relay-check.js searches every table for them.
- **Whoever reads your Orbital settings document can act as your Orbital**: hand your agents node ids and read their
  statuses. That is you, Tana, and anyone you share that document with. Cmd+K → Choose agents → Reset the link key
  makes a new key for the same Orbital, so the agents stay linked.
- **A code is a short secret**: 40 bits, once, fifteen minutes, ten tries a minute per connection.
- **An agent is not trusted with more than its tasks** by Orbital: through the relay it learns only the node ids sent
  to it, and what it sends back is a status, never an action of Orbital's. What it can read and write in Tana is what
  its own Tana access allows, which is yours: link only agents you would give your Tana to.
- **Lifetimes**: a task is deleted when the agent reports on it and after 24 hours regardless; a status when Orbital
  acknowledges it and after 24 hours; a code an hour after it ran out; access tokens last an hour, refresh tokens 90
  days. Nothing is logged but the kind of an unexpected failure.
- **Limits**: 32 KB a request, 200 waiting per agent and per Orbital, 50 agents, five open codes, 120 calls a minute
  per caller.

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
as copied from this repository, with Replit's PostgreSQL (`DATABASE_URL`). The leases are in the database; the rate
limits are per instance.

Still to try:

- Testing with each agent you mean to link (ChatGPT, Grok, Claude): their MCP clients must accept an authorize step
  that asks nothing, and they must call `get_tasks` — on a schedule, or when asked.
