# Sign in with ChatGPT: Orbital's identity

Where Orbital's ChatGPT sign-in stands, what OpenAI documents for an app that wants its own identity, and the plan to
get there. Written 2026-10-04 from OpenAI's documentation of that date and the code on main (f95eb91); the sources are
at the end. Read it before touching `main/ai.js`, `main/agents/codex.js`, `ios/Orbital/Settings.swift`,
`ios/Orbital/Translator.swift` or `android/…/ChatGPTClient.kt`.

**Status.** Nothing here has moved to an identity of Orbital's own yet. The desktop signs in through the Codex
app-server, which OpenAI still allows for a local app. The phones sign in as the Codex CLI. OpenAI's Sign in with
ChatGPT (SIWC) is the documented way for an app to have its own identity, and it needs no certificate, no client secret
and no client id requested in advance: the user's own consent issues one. The migration below has not been started:
its first real step is that consent (see "Blocked before"), and Orbital's eligibility still needs OpenAI's
confirmation (see "Eligibility").

## 1. What each platform does today

| | How it signs in | Where the requests go | Fits OpenAI's documentation? |
|---|---|---|---|
| Desktop | The Codex app-server's managed sign-in, device code flow (`account/login/start` with `chatgptDeviceCode`), in its own Codex home under userData (main/ai.js `ensureChatGPT`, `startChatGPTLogin`). The app-server runs the OAuth itself, with Codex's own client. Orbital names itself in `initialize` as `clientInfo { name: 'orbital', title: 'Orbital', version }` (main/agents/codex.js `appServerRpc`). | `thread/start` and `turn/start` on that app-server (main/ai.js `askChatGPT`). | Yes, for now. The app-server documentation lets a local or open-source app that already uses app-server authentication keep using it, recommends moving to SIWC, and says app-server authentication was never permitted for commercial or hosted services. |
| iPhone | Its own OAuth with PKCE, with Codex's client id `app_EMoamEEZ73f0CkXaXp7hrann`, Codex's scopes, `originator=codex_cli_rs` and `codex_cli_simplified_flow`, redirected to `http://localhost:1455/auth/callback` and caught in an embedded web view (Settings.swift `ChatGPT`, `ChatGPTPage`). | `chatgpt.com/backend-api/codex/responses`, `/codex/models?client_version=99.0.0` and `/transcribe`, with `originator: codex_cli_rs` and, for transcription, the user agent `codex_cli_rs/0.130.0` (Translator.swift). | No. Every request presents Orbital as the Codex CLI, and SIWC's documentation says not to use ChatGPT's `backend-api` endpoints. |
| Android | The iPhone's flow, copied (ChatGPTClient.kt, AndroidPlatform.kt `ChatGPTSignIn`). | The same endpoints and headers. | No, as the iPhone. |

The client id above is Codex's public identifier: it is in the Codex CLI binary (checked in 0.160.0) and is not a
secret. Using it is still presenting Orbital as Codex. #664 and #665 left it as a stopgap for personal test builds,
with whether using Codex's sign-in outside Codex fits OpenAI's terms still unchecked; SIWC is OpenAI's later answer.

Observed while checking, and not changed here: Orbital does not send the `initialized` notification the app-server
documentation asks for after `initialize`. It works today; the desktop migration should add it.

## 2. Four things called "identity"

| | What it is | What Orbital needs |
|---|---|---|
| OAuth client id | The app's identifier at `auth.openai.com`. Under SIWC for open-source and local apps it is **issued per user and workspace** at the user's first consent (an `oaiapp_…` value); there is no one id to build into the app. A **fixed partner id** is a separate path: "Request a client ID" is a waitlist for selected commercial partners. | The per-user flow. Nothing to request in advance. |
| Client certificate | Not part of SIWC. The open-source flow is a public client: no client secret, no mutual TLS, no signed client assertion. The closest thing is an optional host id derived from a public key (RFC 9278), which OpenAI documents as an identifier only, with no proof of the private key. | Nothing to obtain or generate. |
| app-server `clientInfo` | The name an app gives itself in `initialize`. Codex uses `name` as the request originator and `name` with `version` in its User-Agent; enterprise Compliance Logs show it. It authenticates nothing. OpenAI keeps a "known clients list" for integrations meant for enterprise use. | A stable `name` and the real `version` (main/agents/codex.js sends package.json's). The known clients list only if Orbital is aimed at enterprises. |
| Apple and Android signing | Developer ID, provisioning profiles and the APK key prove a binary to macOS, iOS and Android. main/ai.js checks that the standalone app-server it downloads carries OpenAI's Developer ID team. | Unrelated to OAuth. |

The plugin direction is the reverse again: when ChatGPT links an agent through orbital.md/mcp, ChatGPT is the OAuth
client and Orbital's relay is the authorization server (relay/server.js, docs/AGENT-RELAY.md). That gives ChatGPT a
token for Orbital; it never gives Orbital the user's ChatGPT plan.

## 3. The SIWC flow for an open-source or local app

All of this is documented (sources 6 to 13).

1. **Host id.** Before the first sign-in, make and keep one opaque id per installation: `urn:uuid:` and a random
   UUIDv4, or a JWK thumbprint URI, or `did:key`. It is not a credential and must not carry an email or user id.
   It stays the same across restarts, sign-outs and account switches.
2. **Authorize.** Start a loopback listener, then open the **system browser** at
   `https://auth.openai.com/api/accounts/authorize` with a fresh `state`, OIDC `nonce` and PKCE (`S256`):
   - `client_id=dynamic_agent_client` for a new registration. It is the bootstrap value: never saved, never used to
     exchange a code. It goes with `agent_name_hint` (the app's real name, the same on every install; the user can
     edit it) and `ext_agent_host_id`;
   - later sign-ins send the **issued** client id instead, no `agent_name_hint`, the same host id, and optionally
     the retained id token as `id_token_hint` and the email as `login_hint`;
   - `response_type=code`, `scope=openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`,
     `resource=https://api.openai.com/v1`;
   - `redirect_uri` an HTTP loopback on **`127.0.0.1`** with the path `/auth/callback`. Only the port may change
     between sign-ins, `localhost` is not accepted in its place, and the same URI goes in the exchange.
3. **Callback.** Check `state`. `error=access_denied` ends the attempt with no exchange. A new registration
   returns `code` and the issued `client_id`; without it the registration is incomplete. On re-authorization a
   different client id is rejected.
4. **Exchange.** Form POST to `https://auth.openai.com/api/accounts/oauth/token`: `grant_type=authorization_code`,
   the issued client id, `code`, `code_verifier`, the same `redirect_uri` and `resource`. No secret.
5. **Validate.** Check the id token's signature against OpenAI's published keys, its issuer, audience (the issued
   client id), expiry and nonce, and use its `sub` as the account. Plan usage is on only when the granted scopes
   include `chatgpt.tokens.use.direct`; a valid id token alone is not enough.
6. **Store.** One protected record per issued client id and account: identity, id, access and refresh tokens, granted
   scopes, expiry. Owner-only file permissions (0600), written atomically, never in logs, URLs, browser storage,
   analytics or source control. Access tokens last an hour; refresh tokens 30 days and are replaced on every refresh,
   so refreshes for one session must not overlap. A refresh is a form POST with `grant_type=refresh_token`, the
   issued client id and `resource`, without `scope`.
7. **Use.** `POST https://api.openai.com/v1/responses` with the access token as the bearer, `store: false`,
   `stream: true` and `input` as an array; success is the `response.completed` event. Models come from
   `GET https://api.openai.com/v1/models`. Or the token goes to a Codex app-server started with a Responses
   provider that reads it from `ACCESS_TOKEN`, with `clientInfo.name` matching `agent_name_hint`; the app
   refreshes the token and restarts the app-server.
8. **Sign out.** Revoke the refresh token at the `revocation_endpoint` from
   `https://auth.openai.com/.well-known/openid-configuration` (form POST with the issued client id), then clear the
   tokens. Keep the client id and host id for the next sign-in. Revoking does not delete the registration; the user
   removes the app in ChatGPT's settings.

What this route does not support (preview limitations): the transcription API, audio input, the Files API, hosted
tools (image generation, file search, Code Interpreter, hosted MCP), and several request fields (`temperature`,
`max_output_tokens`, `metadata`, `previous_response_id` over HTTP, and others). Errors such as
`subscription_sharing_usage_limit_exceeded` are not retried and point the user to ChatGPT's usage settings.

The interface rules: the button reads **Continue with ChatGPT**; after the first sign-in with plan usage, a one-time
"You're using your ChatGPT plan" with **Got it**; **Using ChatGPT plan** near where the model is chosen, with a
**Manage usage** link to https://chatgpt.com/settings/usage.

## 4. Eligibility: unresolved, for OpenAI to confirm

OpenAI's quickstart makes ChatGPT plan usage available to all open-source partners and selected private clients, and
the open-source overview covers open-source and locally hosted apps, sending paid or remotely hosted ones to an
interest form; the cookbook adds personal projects that run locally. The users it serves are eligible ChatGPT Plus
and Pro accounts.

Orbital is free, runs on the user's own devices and is not hosted. But its licence (LICENSE) forbids selling it, so
it is source-available, not open source in the OSI sense, and its phone builds reach other people through TestFlight
and a downloadable APK, so it is more than a personal project. **It does not clearly fit a documented category.** The
owner cannot settle that by deciding it: where Orbital does not plainly fit, OpenAI has to confirm it, through the
interest form. The documentation also does not say whether a private-client arrangement applies instead; that it is
not written down does not mean there is none.

The owner may separately authorize personal testing on their own machine and account, which the personal-project
category covers more plainly; that is the consent in section 7, and it does not make shipping to others eligible.

## 5. The phones: unverified

The documentation neither supports nor rules out phone apps:

- **The redirect.** The documented flow opens the system browser and returns to a loopback listener on `127.0.0.1`;
  no page says whether that is supported from an iPhone or Android app. Today's phones catch a `localhost` redirect
  inside an embedded web view, which does not match the documented flow on either point. One shape to try is
  ASWebAuthenticationSession (iPhone) or a Custom Tab (Android) with the app listening on `127.0.0.1` while it stays
  in front (an implementation guess, not documentation). **It needs a test on a real device and, for anything shared
  beyond a test build, OpenAI's confirmation.**
- **Dictation.** Quick Add and Ask Tana dictation call ChatGPT's `/transcribe`. The preview limitations exclude the
  transcription API, audio and video input and the Files upload API, so dictation cannot move to SIWC; it needs
  another route (the phone's own speech recognition is the obvious one) or stays off.
- **Everything else** the phones ask (Auto-translate, reading an image, the model list) maps to `/v1/responses` and
  `/v1/models`, which are documented; images are supported when the model accepts them.

## 6. The migration plan

What OpenAI requires is in section 3. Below, each step is marked **[OpenAI]** where it follows a documented
requirement, **[choice]** where it is how Orbital would meet it (open to change in review), **[device]** where it
needs a test on a phone, and **[owner]** or **[OpenAI to confirm]** where it waits on someone.

1. **Desktop.**
   - Loopback sign-in on `127.0.0.1` in the system browser, PKCE, `state` and nonce, `dynamic_agent_client` then
     the issued id, the host id, id-token validation, the plan scope checked, one refresh at a time, revocation on
     sign-out, tokens kept out of logs and URLs, owner-only storage **[OpenAI]**.
   - All of it in one new main/ module (docs/EXTENDING.md, "A main-process module"), id-token checks with node:crypto,
     the token file encrypted with Electron's safeStorage, tokens never sent to the renderer **[choice]**.
   - main/ai.js asks `/v1/responses` with `store: false` and `stream: true`, and reads `/v1/models` **[OpenAI]**,
     directly over HTTPS rather than through the app-server **[choice]**.
   - "Continue with ChatGPT", "Using ChatGPT plan" and "Manage usage" in Settings and Cmd+K **[OpenAI guidelines]**;
     the manual's AI chapter when that PR leaves draft.
   - The app-server device-code sign-in stays until a real SIWC sign-in has worked, then goes, with the standalone
     app-server download **[choice]**; the first real sign-in **[owner]**.
   - Checks on a fake authorize and token server: wrong `state` refused, `dynamic_agent_client` never stored, a
     changed client id refused on re-authorization, a grant without `chatgpt.tokens.use.direct` leaving plan usage
     off, overlapping refreshes serialized **[choice]**.
   - Send `initialized` after `initialize` while the app-server is still used **[OpenAI]**.
2. **Both phones, together.** Codex's client id, `originator`, the spoofed user agent, Codex's scopes and the
   `backend-api` calls go **[OpenAI]**; the desktop's flow in Swift and Kotlin **[OpenAI]**; the redirect as a device
   test shows it working **[device]**; shipping it beyond a test build **[OpenAI to confirm]**; dictation on the
   phone's own speech recognition **[choice]**, because SIWC has no transcription **[OpenAI]**. Existing phone
   sign-ins hold Codex-issued tokens that cannot carry over: users sign in again.
3. **Enterprise attribution**, only if wanted: ask OpenAI to add `orbital` to the known clients list **[owner]**.

## 7. Blocked before

The work stops before **the first real "Continue with ChatGPT" sign-in with `client_id=dynamic_agent_client`**.
That consent is not a test. When the user approves it, OpenAI registers a client for Orbital bound to that user and
workspace and issues its client id, and the exchange that follows issues access, refresh and id tokens that have to be
stored. That is a new registration, new persistent credentials and a new grant, which needs the owner's go-ahead.
So nothing in this repository has started that flow, refreshed or read a token, called a model with one, or revoked
one, and no host id has been generated.

Next steps, in order:

1. **Eligibility, OpenAI to confirm.** Ask through https://openai.com/form/sign-in-with-chatgpt-interest/ whether
   Orbital, free and local but source-available and shared through TestFlight and an APK, qualifies for ChatGPT plan
   usage, and whether phone apps are supported. An external submission, so the owner's.
2. **Personal test, the owner's call.** Authorize the desktop implementation and one sign-in with the owner's own
   Plus or Pro account on their own Mac: consent, choose the workspace, keep the agent's name. That proves the flow;
   it is not permission to ship to others ahead of step 1.
3. **Phones**: the device test of the redirect, then the same consent, shipped only once step 1 allows it.

## Sources

OpenAI's documentation, read 2026-10-04:

1. Codex App Server: initialization, `clientInfo`, the known clients list, auth modes, and the note on app-server
   authentication and SIWC. https://learn.chatgpt.com/docs/app-server
2. Codex authentication. https://learn.chatgpt.com/docs/auth
3. Sign in with ChatGPT, index. https://developers.openai.com/siwc
4. Quickstart: who it is available to. https://developers.openai.com/siwc/quickstart
5. Request a client ID: the commercial partner waitlist. https://developers.openai.com/siwc/request-client-id
6. ChatGPT plan usage, overview: clients, host ids, eligibility. https://developers.openai.com/siwc/token-sharing-open-source
7. Registration and sign-in. https://developers.openai.com/siwc/token-sharing-open-source/sign-in
8. Accounts and sessions: refresh, revocation, credential safety. https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
9. Token reference. https://developers.openai.com/siwc/token-sharing-open-source/token-reference
10. Models and inference. https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
11. Codex app-server with a SIWC token. https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server
12. Preview limitations. https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
13. Errors and recovery. https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
14. UI/UX guidelines. https://developers.openai.com/siwc/ui-ux-guidelines
15. Cookbook: Sign in with ChatGPT in an open-source Electron app. https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
16. What's new, September 28 to October 2, 2026 (the launch). https://learn.chatgpt.com/docs/whats-new/september-28-october-2-2026
17. Plugins: authentication, the reverse direction. https://developers.openai.com/plugins/build/auth
