# Security audit: bop.1on1realtors.com, 2026-11-17

Branch `desk-security-hardening`. Scope: every route under `app/api` (164 `route.ts` files), the pages, `proxy.ts`, `lib/gate.ts`, and the sign-in routes.

## What changed in the gate

With `BOPS_LOGIN_GATE=google` (production), every request needs a signed session (`bops_gate`) from Google sign-in. Before this change, any allowlisted person (every `@1on1realtors.com` agent) reached the whole app, including the chat app at `/`, vault, keys, bots, computers and auth. Now there are three kinds of signed-in person:

- **Owner** (`BOPS_OWNER_EMAILS`): everything, as before.
- **Teacher** (`BOPS_TEACH_EMAILS`): the agent set below, plus `/realty/learn` and its two APIs.
- **Agent** (any other allowlisted person): only the pages and APIs in `lib/gate.ts` (`AGENT_PAGES`, `AGENT_APIS`).

Decision: `gateVerdict()` in `lib/gate.ts`, called by `proxy.ts`. Outcomes:

| Request, signed in as an agent | Before | Now |
|---|---|---|
| Any API not in the agent list | 200 (whatever the route allows) | **403** `{"error":"Not allowed."}` |
| Any page not in the agent list (`/`, `/realty/posts`, `/realty/automatch`, `/realty/search`, `/realty/digest`, `/realty/alerts`, `/realty-demo`, `/realty/requests`, upstream pages) | rendered | **307 redirect to `/realty/desk`** |
| `/realty/desk`, `/realty/market` (and subpaths) | rendered | unchanged |
| `POST /api/realty/match-status` | any live match | **own desk view only** (see Data scoping) |
| `POST /api/realty/tour` | unchanged | unchanged |
| `GET/HEAD /api/realty/media/[hash]` and `/thumb` | unchanged | unchanged (unguessable hashes, accepted) |
| `/realty/learn`, `POST /api/realty/learn`, `/api/realty/learn/questions` | teacher check in route | teacher only at the gate, then the route's own check |
| Static files under `public/` (e.g. `/realty/1on1-realtors-logo.png`), `/favicon.ico`, `/favicon` | loaded | loaded |

Signed out: unchanged (API `401`, page to the sign-in). Owners: unchanged. Gate off (Mac app, dev): unchanged.

## Alternate ways in (item 2 of the review)

Searched the repo for every other way to get a session or bypass the gate. Results:

| Path | What it is | Finding | Action |
|---|---|---|---|
| `/api/gate/login`, `/callback`, `/logout` | Google sign-in | The only login path that sets a site session | Hardened (see below) |
| `proxy.ts` `fromWindow` / `bops_window` cookie / `x-bops-window` header | Mac app window token | Only active when `BOPS_UI_TOKEN` is set. Not set on the hosted server. A request with these and no session gets the sign-in (checked by test) | Left as is (Mac) |
| `lib/server/ui-token.ts` `fromBopsWindow()` | Window check inside routes | **Returns true when no token is set.** On the hosted server the token is unset, so every route that uses only this check is open to anyone who reaches it, **with the gate off**. With the gate on, agents are now refused by the gate, and owners pass. | Documented. Recommend failing closed on hosted (`BOPS_DATABASE_URL` set and no token) once the gate is confirmed on in production |
| `publicDemo()` / `ONEON1_PUBLIC_DEMO` | Public demo mode | On by default on Vercel. Only the demo page and health pass; every other API is refused | Unchanged |
| `lib/server/cloud-tunnel.ts` `fromCloudTunnel()` | Bops Cloud tunnel | Random 32-byte token per process, compared in constant time. Route `/api/cloud/event` only | Unchanged |
| `lib/server/owner-email.ts` `fromThisMac()` | Adding owner emails, phones | Refused when on Postgres (hosted) and unless the hostname is loopback | Unchanged |
| `/api/auth/*` (Orgo account sign-in) | Upstream account, not a site login | Was signed-in only; now owner only at the gate. Does not create a site session | Owner-only via gate |
| `x-forwarded-email`, `x-user-email`, `Authorization` bearer, `?token=` | Header or query identity | None read anywhere in `app/`, `lib/` or `realty/` for identity | Tested: forged values get the sign-in |
| Passwords, magic links, dev bypasses | — | None found | — |
| `scripts/bench-*.mjs`, `desktop/own-call.cjs` | Send `x-bops-window` | Dev and Mac tooling, not a hosted path | Unchanged |

Hosted routes that prove themselves (open at the gate, checked in the route): `/api/apps/call` (bot key), `/api/phone/agentphone` and `/api/phone/openai` (webhook signatures), `/api/channels/slack/events` (Slack signature or tunnel), `/api/intake/periskope` (HMAC; returns 503 with no key), `/api/cloud/event` (tunnel token), `/api/health`.

## Sign-in hardening

- Session cookie `bops_gate`: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, 12 hours (`SESSION_SECONDS`). Logout now sets the same attributes (it set only path and max-age before).
- OAuth callback: the ID token must have `iss` = Google, `aud` = our client id, `exp` in the future, and `email_verified` true (`idTokenIdentity`).
- Allowlist: an exact address matches that address only. A `@domain` entry matches only when Google's `hd` claim equals that domain (a Workspace account). A consumer account with the same name is refused.
- Rate limit: 20 attempts per 10 minutes per client address on the login start and the callback (`lib/gate-rate-limit.ts`), `429` with `Retry-After`. The address is `fly-client-ip`, else the first `X-Forwarded-For` hop. In memory, per server process.
- CSRF (gate on): a write (`POST`, `PUT`, `PATCH`, `DELETE`) to `/api/*` must carry an `Origin` whose host is ours. Without `Origin`, only `Sec-Fetch-Site: same-origin` passes. `Origin: null` is refused (`sameSiteWrite`). The open paths (webhooks, tunnel) are not affected.
- Security headers (`next.config.ts`): `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Content-Security-Policy: frame-ancestors 'self'` only. The CSP is left off the made-app, file and page routes, which set their own sandbox CSP.

## Data scoping

- **`POST /api/realty/match-status`**: an owner may set a status on any match on the desk, as before. An agent may set a status only on a match in the desk view built for them (`liveDesk`, the same function the desk page uses: their own requests, and the matches on listings they hold; `deskHolds`). A pair outside that view is refused as before. An Automatch lead still goes through `leadAccess` (owner or the holder). Test: Sam can't set status on Kerry's request; Kerry can; the owner can.
- **Desk data** (`staffRecommendations`, `staffLeads`): already scoped by the server to the signed-in agent (`liveDesk`, `leadsView` with `agentId`). The request-side market data is owners only. No change needed.
- **Media** (`/api/realty/media/[hash]`): unguessable hashes of listing photos. Accepted, as requested.

## Route inventory (164 routes)

"Before" is the check the route itself had (plus the gate, which was sign-in only). "Now" is what a signed-in **agent** gets from the gate; owners are unchanged everywhere, and the route's own check is kept.

Legend: **SI** = signed-in only. **O** = owner check in the route (`ownerAccess` / `ownerAllowed`). **S** = staff check (`staffAccess`). **T** = teacher check. **W** = Mac window token (`fromBopsWindow`), which is open on hosted (no token set). **L** = local-only hostname check (`fromThisMac`/loopback). **H** = self-proving (signature, secret, tunnel token). **open** = gate-open path. Sensitivity: **H** high (keys, vault, machines, sign-in, money, mail, sends), **M** medium (user data), **L** low.

| Group (routes) | Methods | Before | Now (agent) | Sens | Flag |
|---|---|---|---|---|---|
| `account`, `account/checkout`, `account/credit`, `account/manage` | G, P | SI | 403 | H | Billing and key-bearing calls. Should be owner-only; now owner-only at the gate |
| `analytics` | G, P | SI | 403 | L | |
| `apps`, `apps/approvals` | G, P, PU, D | SI (`apps` some window checks) | 403 | H | Connects and removes app accounts; approvals answer bot permission requests |
| `apps/catalog`, `apps/logo/[app]` | G | SI | 403 | L | |
| `apps/log` | G | W | 403 | M | |
| `apps/call` | P | H (bot key) | unchanged (open) | H | Self-proving |
| `auth`, `auth/poll`, `auth/start`, `auth/signout`, `auth/status` | G, P, D | SI | 403 | H | Upstream Orgo sign-in. Should be owner-only; now owner-only at the gate |
| `bots`, `bots/ai`, `bots/sites`, `bots/terminal` | G, P, PA, D | SI, some W | 403 | H | Create, edit, terminal |
| `brains`, `brains/bot`, `brains/sign-in`, `brains/sign-out` | G, P, PA, D | W | 403 | H | W only: open on hosted without the gate |
| `call` | P | L | 403 | H | Voice call to a bot (OpenAI key) |
| `channels`, `channels/slack` | G, P, PA, D | SI | 403 | H | Stores Telegram and Discord tokens |
| `channels/slack/events` | P | H | unchanged (open) | H | Slack signature |
| `chats`, `chats/[chatId]/compact`, `chats/[chatId]/messages`, `chats/[chatId]/read` | G, P, PA, D | SI | 403 | H/M | Messages send text to bots that act |
| `cloud/event` | P | H (tunnel token) | unchanged (open) | H | Tunnel |
| `computer`, `computer/reset`, `computer/size` | G, P, D | SI | 403 | H | Deletes and resets bot computers |
| `config` | G | none | 403 | L | |
| `crm`, `crm/file`, `crm/undo` | G, P, PA, D | SI | 403 | M | |
| `desktop` | P | SI | 403 | M | |
| `domains`, `domains/search`, `domains/[zone]`, `domains/[zone]/records`, `domains/[zone]/records/[recordId]` | G, P, PA, D | W | 403 | H | DNS records and domain purchase |
| `drafts/send`, `drafts/source` | G, P | W | 403 | H | Sends drafted email as the user |
| `files`, `files/[fileId]` | G, P | SI (open read on Mac) | 403 | L | |
| `frames` | G | SI | 403 | M | |
| `gate/callback`, `gate/login`, `gate/logout` | G, P | open | unchanged (open) | L | Hardened: identity checks, rate limit, cookie attributes |
| `health` | G | open | unchanged (open) | L | |
| `host` | P | SI | 403 | H | Switches sessions between Mac and cloud |
| `hosted-apps`, `hosted-apps/[name]` and subroutes (commits, dns, domains, cloudflare, env, local, logs, password, settings) | G, P, PA, D | SI and W | 403 | H | Deploys, env variables, passwords, DNS |
| `input`, `screen`, `screen-action`, `screen-form` | G, P | SI | 403 | H | Mouse and keyboard on a bot's screen; `screen-form` can save to the vault |
| `intake/periskope` | P | H (HMAC) | unchanged (open) | M | WhatsApp group webhook |
| `intake/periskope/consent`, `intake/periskope/opt-out` | G, P | S | 403 | M | **Behaviour change:** staff (agents) could record consent and opt-outs; now owners only. Confirm this is wanted |
| `judge` | P | SI | 403 | L | |
| `keys`, `keys/[name]`, `keys/reveal` | G, P, PA, D | W | 403 | H | Saved API keys; `reveal` returns a key value |
| `logins` | PA | W | 403 | H | |
| `mac`, `mac/codex`, `mac/window`, `mac/windows` | G, P, PA | SI, L | 403 | H/M | Full access for bots |
| `made-apps`, `made-apps/[appId]`, `made-apps/[appId]/bridge` | G, P | SI | 403 | M | |
| `made-apps/[appId]/view`, `pages/[pageId]` | G | open read (Mac) | 403 | L | Sandboxed page; the owner's app still loads it |
| `mail`, `mail/handle` | G, P | SI | 403 | H | Email setup and address |
| `members` | G, P, PA, D | W | 403 | H | Invites, roles, removal |
| `memory`, `memory/categories` | G, P | SI | 403 | M | |
| `mirror`, `reader`, `transcribe`, `uploads`, `uploads/[uploadId]`, `watches`, `route`, `plan`, `notices`, `runs-on/keys`, `bots/sites` | G, P | SI | 403 | L/M | |
| `orbit/issues`, `orbit/issues/[id]` | G, P, PA, D | SI | 403 | M | |
| `orbit/issues/[id]/source` | G, P | W | 403 | H | Reads email, sends a reply as the user |
| `owner` | G, P | SI | 403 | M | Owner's name and bot profile (not the owner list) |
| `owner-email`, `owner-email/verify/start`, `owner-email/verify/check` | G, P | L/X | 403 | H | Mac only (refused on hosted) |
| `phone`, `phone/lines`, `phone/numbers`, `phone/verify/start`, `phone/verify/check` | G, P | SI, L/X | 403 | H | Numbers and verification |
| `phone/agentphone`, `phone/openai` | P | H (signature) | unchanged (open) | H | Webhooks |
| `privacy` | G, P | W + X | 403 | H | Deletes data |
| `realty/admin-digest`, `realty/automatch-alert`, `realty/posts`, `realty/posts/[messageId]`, `realty/replay`, `realty/search`, `realty/search/export` | G, P | O | 403 (owner check kept) | M | Already owner-only |
| `realty/areas/alias` | P | S | 403 | M | Area alias (goes to market). Owner-only now; the desk doesn't call it |
| `realty/market/search` | G | S | 403 | M | Not called by the market page (server-rendered). Owner-only now |
| `realty/match-status` | P | S | **allowed**, scoped to the agent's own desk | M | See Data scoping |
| `realty/tour` | P | S | **allowed** | L | |
| `realty/media/[hash]`, `realty/media/[hash]/thumb` | G | S | **allowed** (unguessable hash) | L | Accepted |
| `realty/learn`, `realty/learn/questions` | P | T | teachers only | M | Teacher check kept |
| `relay`, `reset`, `restart`, `tailnet`, `takeover`, `vault`, `vault/use`, `vnc`, `workspaces/shared/screen` | G, P, PA, D | SI, L | 403 | H | Machine control, secrets and sign-in. `restart` is local-only |
| `routines`, `routines/[id]/runs`, `routines/suggestions`, `routines/suggestions/dismiss` | G, P, PA, D | W | 403 | H | Creates and runs routines |
| `sessions`, `sessions/[sessionId]`, `sessions/[sessionId]/compact`, `sessions/[sessionId]/reply`, `sessions/[sessionId]/terminal`, `sessions/[sessionId]/where` | G, P, PA, D | SI, W | 403 | H | Threads on bots |
| `setup` | P | SI | 403 | L | Owner-only now |
| `skills` | G, P | SI and W | 403 | H | Installs and publishes scripts |
| `state` | G | SI | 403 | M | Full app state |
| `takeover` | P, D | SI | 403 | H | |
| `view` | P | SI | 403 | L | |
| `watches` | G, P, PA, D | SI | 403 | M | |
| `workspaces`, `workspaces/shared`, `workspaces/shared/people`, `workspaces/shared/settings`, `workspaces/shared/wake` | G, P, PA, D | SI and W | 403 | M/H | Shared workspaces and their people |

Plus the route-level state check `notReady` (409 while loading) on some routes: availability, not auth.

## Routes that should be owner-only but relied only on sign-in

Before this change, any allowlisted agent could reach these. They are now owner-only at the gate. The routes themselves have **no owner check**, so anyone who gets past the gate later gets them. Recommended follow-up: add `ownerAccess` in each route (gate-off behaviour unchanged).

- Upstream account and billing: `account/checkout`, `account/credit`, `account/manage`, `auth/*`, `mail`, `mail/handle`.
- Keys, vault and logins: `vault`, `vault/use`, `screen-form`, `keys` (W only; on hosted without the gate it's open), `channels`.
- Machines, sessions and screens: `reset`, `computer`, `computer/reset`, `computer/size`, `takeover`, `input`, `screen`, `screen-action`, `sessions`, `sessions/[id]/reply`, `chats/[id]/messages`, `desktop`, `host`, `runs-on`, `relay`, `tailnet`.
- Setup and approvals: `setup`, `apps`, `apps/approvals`, `owner`.

Routes that are window-token only (W) fail open on the hosted server with the gate off: `fromBopsWindow` returns true when `BOPS_UI_TOKEN` is unset. The gate closes this in production. Recommended: fail closed on hosted when no token is set.

## Test coverage

`realty/test/security-gate.test.ts` covers the agent/owner/teacher matrix over the sensitive APIs and pages, the static files, signed-out requests, forged headers and cookies, a wrong-secret and an expired session, the OAuth identity rules, the Workspace `hd` rule, the rate limit, the CSRF cases, the security headers, the agent-visible copy, a source scan for "Bops" on the desk and market, and match-status scoping.
