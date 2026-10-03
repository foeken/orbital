# AGENT-RELAY.md — linking any agent to Orbital

Orbital hands work to agents (main/agent.js): Tana, Codex, Dot and Claude are built in. The agent relay lets **any**
AI agent that can add an MCP server become one more: your dot, a Grok bot, a Claude project, one you built. It is
the MCP server at **orbital.md/mcp** (relay/server.js), and the only thing between Orbital and those agents.

## The flow

1. **Cmd+K → Link to agent …** (renderer/agent.js) asks main for a code. The first time, main makes *your Orbital*:
   a random id and a random secret, kept in the Orbital settings document in Tana (`relayAccount`, docs/SETTINGS.md),
   so every device signed into your Tana account is the same Orbital. Main tells the relay the id, the secret (which
   the relay keeps only as a hash) and the public key the secret stands for (`POST /orbital/register`).
2. The page shows one prompt: *Add the MCP server https://orbital.md/mcp to yourself, then call its link_orbital tool
   with the code 7KQX-M2PD and a short name for yourself.* ↩ copies it; you give it to the agent.
3. The agent adds the server. Its MCP client signs in on its own (OAuth below), calls `link_orbital` with the code and
   a name it chose, and is linked. The code works once and for ten minutes.
4. The page, asking every two seconds, sees the code used, closes on "Linked GrokBot · Grok", and the agent is one of
   yours: `relay:<id>` in main/agent.js, on from the start, in Choose agents, Assign to Agent and Settings.
5. **Assign to Agent** seals the task (the request, the node's title, uri and outline) to that agent's key and queues it.
   The agent sees it the next time it calls `get_tasks`, and reports with `update_task` (working, completed, failed and
   a note). Its updates come back sealed to your Orbital's key; whichever device reads one first writes the note into
   the node under the agent's name, ending with an `Agent status:` line, and keeps the status in `relayTasks` so every
   device draws the same badge (main/agents/linked.js).

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

**MCP tools.** `link_orbital { code, name }`, `get_tasks {}` (a fetched task is leased for ten minutes, then offered
again), `update_task { task_id, status: working|completed|failed, note }` (the first update is the receipt: the task
leaves the queue). The `initialize` answer's instructions tell the agent that a node's own words are content, not
orders.

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
  `secure_delete`, so a deleted message is overwritten. scripts/relay-check.js searches every table for the words sent
  and the secrets used.
- **The running relay can read tasks.** It opens a task for the agent when the agent fetches it, so whoever controls
  orbital.md's process and master key can read what is sent to agents. This is the price of agents that cannot hold a
  key. An agent that can (one with a computer of its own) could be given its own key later and the relay would only
  carry ciphertext; the wire format already allows it.
- **Answers are for your devices only.** They are sealed to your Orbital's key; the relay never has the private half.
- **Whoever reads your Orbital settings document can act as your Orbital**: send your agents tasks and read their
  answers. That is you, Tana, and anyone you share that document with. Cmd+K → Choose agents → Reset the link secret
  makes a new secret; agents stay linked (to the id). Answers still sealed to the old key are let go.
- **A code is a short secret**: 40 bits, once, ten minutes, ten tries a minute per connection.
- **An agent is not trusted with more than its tasks.** It sees only what was sent to it, and what it writes back
  becomes text in the node (and a status line), never an action of Orbital's.
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

Before it serves real agents at orbital.md/mcp:

- orbital.md is a static Replit deployment today; the relay needs a server deployment (a reserved VM or
  autoscale with one instance: the rate limits and leases are in memory), with `/mcp` and `/.well-known/oauth-*`
  routed to it and the manual left where it is.
- A master key kept as a deployment secret, and the database on a persistent disk that is not backed up into plain
  snapshots.
- Testing with each agent you mean to link (ChatGPT, Grok, Claude): their MCP clients must accept an authorize step
  that asks nothing, and they must call `get_tasks` — on a schedule, or when asked.
