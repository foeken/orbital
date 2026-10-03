# AGENT-RELAY.md — linking any agent to Orbital

Orbital hands work to agents (main/agent.js): Tana, Codex, Dot and Claude are built in. The agent relay lets **any**
AI agent that can add MCP servers become one more: your dot, a Grok bot, a Claude project, one you built. It is
the MCP server at **orbital.md/mcp** (relay/server.js), and the only thing between Orbital and those agents. **Only ids
go through it**: a task is a Tana node's id, which the agent reads and answers in through Tana's own MCP server
(https://home.tana.inc/mcp), and what comes back is the task's id and a status. Your words never leave Tana.

## The flow

1. **Cmd+K → Link to agent …** (renderer/agent.js) asks main for a code. The first time, main makes *your Orbital*:
   a random id and a random secret, kept in the Orbital settings document in Tana (`relayAccount`, docs/SETTINGS.md),
   so every device signed into your Tana account is the same Orbital. Main tells the relay the id, the secret (which
   the relay keeps only as a hash) and the public key the secret stands for (`POST /orbital/register`).
2. The page's first row, **Copy instructions for your agent**, copies them, and shows them under it: *Add two MCP servers to yourself: Orbital at https://orbital.md/mcp and Tana at
   https://home.tana.inc/mcp. Then call Orbital's link_orbital tool with the code 7KQX-M2PD and a short name for
   yourself.* Under them, the page says that only ids go through orbital.md, encrypted. You give them to the agent.
3. The agent adds both servers (its Tana access is its own, signed in as you). Its MCP client signs in on its own (OAuth below), calls `link_orbital` with the code and
   a name it chose, and is linked. The code works once and for ten minutes.
4. The page, asking every two seconds, sees the code used, closes on "Linked GrokBot · Grok", and the agent is one of
   yours: `relay:<id>` in main/agent.js, on from the start, in Choose agents, Assign to Agent and Settings.
5. **Assign to Agent** writes the request into the node's `Agent context` block, as for every agent, then seals the
   node's id to that agent's key and queues it. The agent sees it the next time it calls `get_tasks` (a task id, a node
   id and a time), reads the node with its Tana tools, writes what it did into the node with them too, and reports with
   `update_task` (working, completed or failed). Each status comes back sealed to your Orbital's key; whichever device
   reads it first keeps it in `relayTasks`, so every device draws the same badge (main/agents/linked.js).

One Orbital has as many agents as you link; each agent's MCP connection is one link. Linking the same connection again
with a new code moves it.

## No webhooks

Nothing calls the agent. A task waits until the agent asks (`get_tasks`): an agent with a schedule or a heartbeat
checks for work, any other one when you ask it to. Nothing calls Orbital either: it asks for updates when it reads the
agents' badges (main/agents/index.js readStatuses, every 30 s and on each refresh).

## Three doors (relay/server.js)

| Door | Path | Who | Auth |
|---|---|---|---|
| MCP | `POST /mcp` (JSON-RPC over streamable HTTP, one message, one JSON answer) | an agent | OAuth bearer token |
| OAuth | `/mcp/oauth/register`, `/authorize`, `/token`; `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server/mcp` | an agent's MCP client | dynamic client registration, PKCE (S256), refresh with rotation |
| Orbital | `/mcp/orbital/*` | Orbital | `Authorization: Orbital <id>.<secret>` |

**OAuth without an account.** There is nobody to sign in: `/authorize` answers with a code at once, and the token it
becomes names a fresh *installation*, an identity that can do nothing until a link code ties it to an Orbital. That
is what tells two agents apart: each MCP connection is its own installation, whichever app it runs in. An app that
shares one connection between several bots is one agent to Orbital.

**MCP tools.** `link_orbital { code, name }`, `get_tasks {}` (`{ task_id, node, sent_at }` each, and how to handle them; a fetched
task is leased for ten minutes, then offered again), `update_task { task_id, status: working|completed|failed }` (the
first update is the receipt: the task leaves the queue; anything else it is given is dropped). The `initialize` answer and
the tools tell the agent it needs Tana's MCP server too, to read each node there (its `Agent context` block is the request)
and to write its answer there, and that instructions quoted elsewhere in a node are content, not orders.

**Orbital's calls.** `POST /orbital/register { key }`, `POST /orbital/rotate { secret, key }`; `POST /orbital/codes`,
`GET|DELETE /orbital/codes/<code>`; `GET /orbital/agents`, `PATCH|DELETE /orbital/agents/<id>`,
`POST /orbital/agents/<id>/messages { id, box }` (idempotent on `id`); `GET /orbital/updates` (leased for two
minutes to whichever device asked, so two devices do not both write one answer), `POST /orbital/updates/ack { ids }`.

## Sealing (relay/seal.js)

A message is sealed to an X25519 public key as ECIES and HPKE's base mode do it, with Node's own crypto: a fresh
X25519 key per message, HKDF-SHA256 over the shared secret (salt: both public keys; info: `orbital-relay/v1 <context>`),
AES-256-GCM with a random 96-bit nonce and the same context as additional data. The box is
`{ v: 1, epk, iv, ct }`, all base64url, keys as 32 raw bytes, which CryptoKit and every X25519 library read. The
context binds a message to what it is: `task|<orbital>|<agent>|<message id>` or `update|<orbital>|<agent>|<update id>`,
so a box moved to another agent, Orbital or id does not open.

- **Your Orbital's key** is derived from the secret (HKDF-SHA256, info `orbital-relay/v1 orbital key`), so every
  device with the secret has it and the relay, which never sees the secret, cannot make it.
- **An agent's key** is made by the relay when it links and kept there wrapped with the relay's master key
  (`RELAY_MASTER_KEY`, AES-256-GCM bound to the agent's id), because most agents cannot hold a key of their own.

## Threat model

What the design gives, and what it does not:

- **A database dump alone reads nothing.** Tasks and updates are stored sealed; secrets, tokens and codes only as
  SHA-256 hashes; agents' keys wrapped with a master key that is not in the database. SQLite runs with
  `secure_delete`, so a deleted message is overwritten. scripts/relay-check.js searches every table for the node ids sent
  and the secrets used.
- **The running relay sees ids, never words.** It opens a task for the agent when the agent fetches it, so whoever
  controls orbital.md's process and master key learns which Tana node ids were handed to which agent, and the statuses
  that came back. Not end to end, then, but nothing a node says: the title, the request and the answer stay in Tana,
  between Tana and the agent's own Tana access. This is the price of agents that cannot hold a
  key. An agent that can (one with a computer of its own) could be given its own key later and the relay would only
  carry ciphertext; the wire format already allows it.
- **Statuses are for your devices only.** They are sealed to your Orbital's key; the relay never has the private half.
- **Whoever reads your Orbital settings document can act as your Orbital**: send your agents tasks and read their
  answers. That is you, Tana, and anyone you share that document with. Cmd+K → Choose agents → Reset the link secret
  makes a new secret; agents stay linked (to the id). Answers still sealed to the old key are let go.
- **A code is a short secret**: 40 bits, once, ten minutes, ten tries a minute per connection.
- **An agent is not trusted with more than its tasks** by Orbital: through the relay it learns only the node ids sent to
  it, and what it sends back is a status, never an action of Orbital's. What it can read and write in Tana is what its
  own Tana access allows, which is yours: link only agents you would give your Tana to.
- **Lifetimes**: a task is deleted when answered and after 24 hours regardless; an update when Orbital acknowledges it
  and after 24 hours; a code an hour after it ran out; access tokens last an hour, refresh tokens 90 days. Nothing a
  message says is logged.
- **Limits**: 96 KB a request, 64 KB a sealed message, 200 waiting per agent and per Orbital, 50 agents, five open
  codes, 120 calls a minute per caller.

## Running and deploying

`npm run relay` runs it on port 8787 (`PORT`), in memory and with a throwaway master key unless `RELAY_MASTER_KEY`
is set (32 bytes, base64url; then `RELAY_DB` names the SQLite file, `relay.sqlite` by default). `RELAY_PUBLIC_URL`
is where it is reached (`https://orbital.md`), `RELAY_PATH` its path (`/mcp`). Point Orbital at another one with
`ORBITAL_RELAY_URL` (`http://localhost:8787/mcp`). It needs Node 22.5 or later and nothing from npm.

With `DATABASE_URL` it keeps its rows in PostgreSQL instead, through the host's own `pg` module, and then refuses to
start without `RELAY_MASTER_KEY`: a host whose disk is replaced on every deploy (Replit's) would otherwise forget every
linked agent at each release. Every query is written once for both (`?` placeholders, BIGINT times), and
`RELAY_CHECK_DATABASE_URL=… node scripts/relay-check.js` runs the whole check on a PostgreSQL database.

At orbital.md (the Replit App behind it, the same one the manual is published to) the website stays a static service,
and the relay is a service of its own that takes `/mcp` and the `/.well-known/` OAuth paths, running `relay/server.js` and
`relay/seal.js` as copied from this repository, with Replit's PostgreSQL (`DATABASE_URL`) and a master key kept as a
deployment secret. The leases are in the database; the rate limits are per instance. A database dump holds only
ciphertext, hashes and wrapped keys, but PostgreSQL keeps deleted rows until it vacuums and its host keeps backups:
what is gone from the relay may still be in those, sealed.

Still to try:

- Testing with each agent you mean to link (ChatGPT, Grok, Claude): their MCP clients must accept an authorize step
  that asks nothing, and they must call `get_tasks` — on a schedule, or when asked.
