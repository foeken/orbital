# AGENT-RELAY.md — linking any agent to Orbital

Orbital hands work to agents (main/agent.js): Tana, Codex, Dot and Claude are built in. The agent relay lets **any**
AI agent that can add MCP servers become one more: your dot, a Grok bot, a Claude project, one you built. It is
the MCP server at **orbital.md/mcp** (relay/server.js), plain JSON over HTTPS, and the only thing between Orbital and
those agents. **Only ids go through it**: a task is a Tana node's id and an action, which the agent carries out by
reading and answering in the node through Tana's own MCP server (https://home.tana.inc/mcp); what comes back is the
task's id and a status. Your words never leave Tana.

## The flow

1. **Cmd+K → Link to agent …** (renderer/agent.js) asks main for a code. The first time, main makes *your Orbital*:
   one random key, kept in the Orbital settings document in Tana (`relayKey`, docs/SETTINGS.md), so every device
   signed into your Tana account is the same Orbital. The relay keeps only the key's hash, and makes the Orbital the
   first time that key asks for a code.
2. The page's first row, **Copy instructions for your agent**, copies them, and shows them under it: *Add two MCP
   servers to yourself: Orbital at https://orbital.md/mcp and Tana at https://home.tana.inc/mcp. Then call Orbital's
   link_orbital tool with the code 7KQX-M2PD and a short name for yourself.* Under them, the page says that only ids go
   through orbital.md. You give them to the agent.
3. The agent adds both servers (its Tana access is its own, signed in as you). Its MCP client signs in to Orbital's on
   its own (OAuth below), calls `link_orbital` with the code and a name it chose, and is linked. The code works once and
   for ten minutes.
4. The page, asking every two seconds, sees the code used, closes on "Linked GrokBot · Grok", and the agent is one of
   yours: `relay:<id>` in main/agent.js, on from the start, in Choose agents, Assign to Agent and Settings.
5. **Assign to Agent** writes the request into the node's `Agent context` block, as for every agent, then queues
   `{ id, node, action: "assign" }` for that agent. The agent sees it the next time it calls `get_tasks`, reads the node
   with its Tana tools, writes what it did into the node with them too, and reports with `update_task` (working,
   completed or failed). Whichever of your devices reads a status first keeps it in `relayTasks`, so every device draws
   the same badge (main/agents/linked.js).

One Orbital has as many agents as you link; each agent's MCP connection is one link. Linking the same connection again
with a new code moves it. `assign` is the one action today; the field is there so a later one (such as cancel) needs no
new message.

## No webhooks

Nothing calls the agent. A task waits until the agent asks (`get_tasks`): an agent with a schedule or a heartbeat
checks for work, any other one when you ask it to. Nothing calls Orbital either: it asks for statuses when it reads the
agents' badges (main/agents/index.js readStatuses, every 30 s and on each refresh).

## Three doors (relay/server.js)

| Door | Path | Who | Auth |
|---|---|---|---|
| MCP | `POST /mcp` (JSON-RPC over streamable HTTP, one message, one JSON answer) | an agent | OAuth bearer token |
| OAuth | `/mcp/oauth/register`, `/authorize`, `/token`; `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server/mcp` | an agent's MCP client | dynamic client registration, PKCE (S256), refresh with rotation |
| Orbital | `/mcp/orbital/*` | Orbital | `Authorization: Orbital <key>` |

**OAuth without an account.** There is nobody to sign in: `/authorize` answers with a code at once, and the token it
becomes names a fresh *installation*, an identity that can do nothing until a link code ties it to an Orbital. That
is what tells two agents apart: each MCP connection is its own installation, whichever app it runs in. An app that
shares one connection between several bots is one agent to Orbital.

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
- **A code is a short secret**: 40 bits, once, ten minutes, ten tries a minute per connection.
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

