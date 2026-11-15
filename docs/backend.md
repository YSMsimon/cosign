# Cosign backend

Next.js route handlers over SQLite (Drizzle), Circle developer-controlled wallets and the
`CompanyTreasury` contract on Arc testnet. Everything lives under `/api/v1`, served by one router:
[`src/lib/server/router.ts`](../src/lib/server/router.ts) (the endpoint table there is the source of truth).

## Concepts

| Thing | What it is | Where it lives |
|---|---|---|
| Workspace | A company. One per treasury contract created by our factory | SQLite `workspaces` |
| Member | A wallet address invited to a workspace, with a role and a free-text title (CEO, CFO, …) | SQLite `members` |
| Role | A set of permissions. Two fixed major roles + editable member-level roles | SQLite `roles` |
| Agent | Name, job prompt, visibility, abilities, wallet controls, **one wallet**, a microVM, shared memory, one conversation per person | SQLite `agents`, `~/.cosign/sandboxes/<ref>` |
| Payment | A proposal in the treasury contract; an agent drafts, approvers cosign from their own wallets | Arc testnet |
| Task | Background work for Grok Bot (or our own loop when no Bot is connected) | SQLite `tasks` |
| Schedule | When a task runs, stored here; the tick fires due ones | SQLite `schedules` |
| Team message | An @mention one agent made with the `mention` tool (to an agent or a person), or a mentioned agent's answer | SQLite `team_messages` |

## Sign-in and access

- **Wallet sign-in only (SIWE, EIP-4361).** `GET /auth/nonce` → the wallet signs a SIWE message for this
  host on Arc testnet (chain 5042002) → `POST /auth/verify {message, signature}` sets an httpOnly
  `cosign_session` cookie (7 days; only its hash is stored). Nonces are single-use and expire in 10 minutes.
- **Invite = access.** An All access member adds a wallet address with a role; whoever signs in with
  that wallet is in. No email, no outsiders.
- Workspaces you are not in answer 404.

## Roles

| Permission | All access | Approver | Builder | Agent user | Viewer |
|---|---|---|---|---|---|
| `workspace.manage`, `members.manage`, `roles.manage` | ✓ | | | | |
| `agents.manage` (team agents, edit any agent) | ✓ | | | | |
| `agents.money` (money abilities, loosen limits, unfreeze) | ✓ | | | | |
| `grokbot.manage` | ✓ | | | | |
| `payments.cosign` (wallet must also be an approver onchain) | ✓ | ✓ | | | |
| `agents.freeze`, `agents.sweep` | ✓ | ✓ | | | |
| `treasury.view`, `agents.use_team` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `agents.build` (private agents), `contacts.manage`, `schedules.create` | ✓ | ✓ | ✓ | | |
| `payments.request` (ask agents to buy, draft, draw petty cash; OK purchases) | ✓ | ✓ | ✓ | ✓ | |

All access and Approver are fixed. Builder, Agent user and Viewer are presets that All access can
edit, delete, or copy into new roles; custom roles may only hold member-level permissions.
A workspace always keeps at least one All access member.

## Agents

- **Visibility.** `private`: only its creator talks to it. `team`: every member with `agents.use_team`
  (optionally only chosen roles). All access can see and manage private agents but not talk to them.
- **Abilities** (presets `readonly`, `buyer`, `clerk`): `sandbox` (own microVM), `buy` (pay for API data
  from its wallet), `draft` (treasury proposals; humans cosign), `pettyCash` (draw from the treasury).
  A tool the agent may not use is never offered to the model.
- **The person asking narrows the agent.** Money abilities only work for members with
  `payments.request`; a Viewer can talk to the Clerk but it won't draft for them.
- **Who changes what.** Builders create private read-only agents; All access creates team agents and
  turns on money abilities. Anything that loosens limits needs All access; the creator, Approvers and
  All access can tighten or freeze.
- **Payees and paid APIs.** What an agent may pay reaches it only when it looks: `list_allowed` with
  `list: payees | sellers | all`. Payees come from the contact book (name, wallet address, notes; also
  `context/contacts.json` in its microVM); sellers are its paid-API allowlist, each with the free catalog it
  publishes (services and prices). Both are rebuilt every run from the database, and `policy.md` points to
  the tool instead of repeating them. The system prompt (fixed, so it stays cached) says to check
  `list_allowed` before saying it can't pay someone or use an API, to pay a name with that payee's saved
  address, to refuse an invoice whose name and address belong to different payees, and not to redo an
  action when a message repeats the last one. Adding a payee = add the contact, then add its address to the
  agent's allowed payees.
- **Speed (measured 2026-11-14 through ElevenLabs).** First words 1.2 to 2 s; a balance check about 3 s; a
  paid vendor check plus a draft about 7 s, mostly Grok thinking (1.5 to 2.5 s per step). Receipts are polled
  every 0.5 s and Circle's broadcast every 0.3 s (the 4 s and 1 s defaults made each onchain draft take 6 to 8
  s; now about 1.5 to 2 s). The microVM starts in the background (only sandbox_bash waits for it) and its check
  is skipped for a minute after it passes. Petty cash reads the remaining allowance before sending, so a draw
  the contract would refuse answers in about 3 s instead of 13. When ElevenLabs re-sends what the person just
  said (re-transcribed, e.g. "fifty cents" / "50 cents"), the request joins the running turn instead of
  queueing a second one. A spoken draft takes about 5 s end to end. Each spoken turn logs one `[voice]` line.
- **Empty replies.** Grok occasionally ends a turn with no text after a tool call; the loop then asks once
  more for the answer.
- **When instructions change** (a new release of the system prompt), the loop re-sends them once to
  conversations already running, since they normally go out only when a conversation chain starts.

### Wallet controls (checked by our server before Circle signs)

1. Per-payment cap, separately for API purchases and drafts
2. Rolling budgets: last 24 h / 7 days / 30 days (per-payment ≤ daily ≤ weekly ≤ monthly)
3. Speed limit: payments per hour
4. Allowlists, everything else blocked: sellers and payees (addresses). A seller entry is
   `host[:port][/path]`: `x402.quicknode.com` (default port only), `localhost:3000/api/sellers` (that port,
   under that path). A bare host never matches another port, plain http works only for loopback, and
   redirects are returned, not followed. `paid_fetch` runs on our server, so a loose entry would let an
   agent reach anything the server can (a Grok Bot run probed every local port when the Clerk allowed
   `localhost`).
5. Ask a person above $X: the purchase waits as an approval request; a member's OK lets it through once
6. Freeze now, optional end date
7. Sweep: wallet balance back to the treasury (the only destination)

Circle's developer-controlled wallets have no spending-policy API (Circle's policies exist only for its
mainnet Agent Wallets), so these live here. The onchain weekly petty-cash allowance stays the hard ceiling.

### Onchain parts are prepared, not signed by us

`GET /agents/:id/onchain` returns the transactions an approver signs in their own wallet so the contract
matches the agent's settings: `setProposer`, `setAgentAllowance`, and a small gas transfer. Cosigning
(`/proposals/:pid/cosign`), cancelling and approver changes (`/approver-changes`) work the same way:
the API returns `{ chainId, to, data, value, description }`; the frontend sends it with the wallet.

## Chat

`POST /agents/:id/chat {message, note?}` streams Server-Sent Events: `step` for every loop event (Grok
thinking, web/X searches, tool calls with arguments, results, refusals, and `text_delta` for each piece of the
answer as Grok writes it), then `done` with the answer, token use and cost. `note` is context for the model
with this message only (the app sends the room a message came from); it isn't saved in the thread. Each person has their own thread (`GET /agents/:id/thread`); memory is shared. The thread
returns each tool call with its arguments and its (parsed, 1,500-character) result, so the app can redraw a turn's
cards after a reload. The frontend that reads all this is described in [frontend.md](frontend.md).

## Live feed

`GET /workspaces/:ws/activity/stream` (needs `treasury.view`) is one SSE stream per open page:
- `activity`: decoded onchain treasury events.
- `proposal.drafted`: sent the moment an agent's draft is onchain, from chat, voice or Grok Bot:
  `{ workspaceId, treasury, proposalId, agentId, requestedBy, taskId, to, amountUsd, memo, tx, at }`.
  `taskId` is the voice session or task it came from, so the page in that call opens the cosign card;
  every page can add it to #approvals. The model never decides what appears on screen.
- `team.message`: an agent @mentioned a teammate or a person, or a mentioned agent answered (a `team_messages` row).

Events come from an in-process bus, so this needs one long-running server (not serverless functions).

`GET /workspaces/:ws/activity` answers from what's stored, and starts a background read of anything new on Arc for
that treasury (its own events, and USDC moving in or out of it through Arc's system emitter), decoded with the
stream's decoder and stored (deduped on tx hash + log index, so it agrees with the QuickNode stream's rows). New rows
reach open pages through the live stream. Arc's public RPC allows at most 10,000 blocks per log query and about one
request a second, so the read is paced (one call every 1.1 s), newest blocks first, then back to the newest stored
row or about 3 days (the treasury's start, if later). It keeps its place after each chunk, and after a refusal it
waits 30 s and carries on. At most one read runs per treasury, at most every 15 s.

Other reads from Arc's public RPC retry with backoff when it rate-limits (429), and executed or cancelled
proposals are read once and kept (they never change). The app refreshes once per burst of live events.

## Wallet: what an agent's own wallet can do (Circle App Kit)

An agent's own Circle wallet can do more than pay per use. These tools, all under the `buy` ability (shown as
"Spend from its own wallet"), go through Circle App Kit (`@circle-fin/app-kit` 1.20.0 with
`@circle-fin/adapter-circle-wallets` 1.9.0, signed by the developer-controlled wallet with our API key and entity
secret; `src/lib/appkit.ts`):

| Tool | App Kit | What it does | Extra control |
|---|---|---|---|
| `send_usdc(to, amount_usd, memo)` | `kit.send` | USDC to an allowed payee | `allowedPayees` |
| `swap(token_out, amount_usd, dry_run?)` | `kit.estimateSwap`, `kit.swap` | USDC into another token, back to the same wallet | `allowedSwapTokens`, `maxSlippageBps` (default 300 = 3%) |
| `bridge(to, chain, amount_usd)` | `kit.estimateBridge`, `kit.bridge` (CCTP, forwarder) | USDC to another chain, to an allowed payee or its own address | `allowedBridgeChains` |
| `gateway_deposit(amount_usd)` | `unifiedBalance.deposit` | tops up its Circle Gateway balance (what nanopayments draw from) | none beyond the limits |
| `earn(action, amount_usd?, vault?)` | `earn.exploreVaults`, `deposit`, `getPosition`, `withdraw` | parks idle USDC in a Morpho vault and takes it back (`withdraw` takes `all`) | `earnVaults` |
| `borrow(action, amount_usd?, market?)` | `borrow.exploreMarkets`, `getBorrowQuote` | market list and quotes only (see below) | `borrowMarkets` |

Every outflow (send, swap, bridge amount plus fees, Gateway deposit, Earn deposit) counts as a purchase for every
wallet limit (per payment, budgets, speed limit) and waits for a member's OK above the ask-a-person line
(`beforePurchase`). Limits are checked before App Kit is asked for a price. An Earn withdrawal returns money to the
same wallet and isn't counted. A bridge whose forwarder fee is at least the amount is refused before anything moves.
Treasury payments still go through `propose_payment` and a person's cosign.

What App Kit can't do from our wallets, found by testing on Arc testnet (2026-11-15):

- **Borrow and repay**: App Kit borrows only from wallets that can settle an atomic batch (a Circle ERC-6900
  smart-contract account, or an EIP-5792 wallet). Our agent wallets are developer-controlled EOAs, so `borrow`
  stops at quotes and refuses a loan before asking anyone.
- **Swap into cirBTC**: "No route available"; only USDC to EURC routes on Arc testnet.
- **Off-ramp** and arbitrary contract calls aren't App Kit actions. Contract calls go through Circle's wallet API
  (`callFrom` in `arc.ts`).

Tested live on Arc testnet (2026-11-15) with Clerk's wallet:

| Action | Result |
|---|---|
| send $0.01 to Lena | tx `0xa7f73ce1…` |
| swap $0.05 USDC to EURC | 0.068022 EURC, tx `0xb1a7ac6c…` |
| Gateway deposit $0.05 | tx `0x3e3007a0…` |
| Earn deposit $0.05 | tx `0x491ce9fe…` |
| Earn withdraw all ($0.049999) | tx `0x1c138eb2…` |
| bridge $0.20 to Base Sepolia, its own address | approve, burn, attestation, mint `0x98198d16…` on Base Sepolia; fees $0.0835 |
| bridge $0.05 | refused: fee $0.0553 |
| borrow quote $1 | 0.00001917 cirBTC collateral, health factor 1.24 |
| borrow $0.01 | refused by App Kit (EOA) |

App Kit's Earn position trails a deposit by a few minutes, so `earn withdraw` reads the position first and says so
when it is still empty.

## Adding funds: the onramp, started by the agent

An agent never buys crypto and never sees payment details. When the treasury is too short for what is waiting, it
calls `request_funds(amount_usd, reason)`: Cosign stores a funding request and @mentions an approver (else a workspace
manager) in the team feed with the amount and the reason. That person opens Circle's onramp from the request
(`POST /workspaces/:ws/onramp { requestId }`). The server creates the session with `createAppServerKit().onramp`
(sandbox `api-test.circle.com` / `onramp-sandbox.arc.io` when the key is a `TEST_API_KEY`), always for the
workspace treasury on Arc testnet, never an address the agent chose, and returns the widget URL. The person
pays in Circle's widget, and the USDC lands in the treasury. There is no separate "add funds" button: the request in
chat is the entry point. Off-ramp to a bank isn't part of App Kit.

Tested 2026-11-15: `request_funds` for $5.40 asked the Founder and moved nothing. A sandbox session was created
for the treasury `0xb496…e62c`, and its widget opened in Chrome.

## Team: agents hand work to each other

Every agent, ours or Grok Bot (through its tool API), has two tools:

- `list_team`: the people (name, role) and the agents the person it works for may use (name, what it does,
  `live` or `background (Grok Bot)`, busy or not).
- `mention(who, message)`: posts the message to the team feed with a real @mention, by id (never parsed from text).
  Mentioning **an agent** starts a task for it (`source: "agent"`), under the rights of the same person: on its
  Grok Bot routine if one is connected, otherwise on our own loop. Mentioning **a person** notifies them in the feed.
  When the mentioned agent's task ends, its result (or `Couldn't finish: …`) is posted back in the same chain.
  If its Grok Bot can't be reached, Cosign posts `Couldn't start …`: never silence.

Guards (`src/lib/server/team.ts`), per chain of hand-offs since a person or a schedule started the work:
- one agent can ask the same agent at most 3 times (the first ask and 2 retries);
- at most 6 agent-to-agent hand-offs without a person;
- an agent can't mention itself, and only agents the person may use can be woken;
- a mention never approves or signs: money still ends at a person's cosign.

Read the feed with `GET /workspaces/:ws/team/messages` or live as `team.message` on the activity stream; the team
as the caller sees it is `GET /workspaces/:ws/team`. The agent's instructions say to mention someone only when
something is wrong or needs them, and to just report when the work went fine.

## Grok Bot (webhook routine)

1. `GET /agents/:id/grokbot` → `setupMessage` for the member to paste into one Bot's own chat in the
   Grok Bot desktop app. The Bot creates the routine "Cosign: <agent>" and shows its Webhook URL and Key.
2. `POST /agents/:id/grokbot {webhookUrl, webhookKey}` stores them (key encrypted with `COSIGN_SECRET`),
   sends a ping and waits for the routine's ack.
3. Each task (`POST /agents/:id/tasks`, or a due schedule) is one webhook POST:

```json
{
  "kind": "task",
  "task_id": "task_…",
  "agent": { "id": "ag_…", "name": "Clerk" },
  "workspace": { "name": "Nova Labs" },
  "instructions": "…",
  "conversation": { "key": "ag_…:mem_…" },
  "api": { "base": ".../api/v1/bot", "token": "…", "expires_at": "…", "context_url": ".../bot/context", "tools_url": ".../bot/tools/{name}" },
  "callbacks": { "ack": "…/ack", "progress": "…/progress", "result": "…/result", "bearer": "…" }
}
```

The token works for that task only, for 30 minutes, and stops once the task is done. Every tool call
goes through the same checks as the chat, under the rights of the member who asked. The Bot gets the
money and memory tools, not the microVM tools (it has its own computer). With no Bot connected, tasks
run on our own loop. The header that carries the webhook key still needs confirming with a live ping from the desktop app.
We send `Authorization: Bearer` and `X-Webhook-Key`; `GROKBOT_WEBHOOK_HEADER=<name>` sends only that one.

Every job body also carries `setup`: the routine's standing rules (`routineGuide` in grokbot.ts, the same text the
setup message installs as the routine's prompt). A routine whose saved prompt is missing or older follows the current
rules anyway, so the member only pastes the setup message once. Every tool call a job makes (tool API or MCP) is kept
on the task as a progress step with `kind: "tool"` (`name · ok | refused: … | error: …`).

### MCP connector

Grok Bot can also reach the same tools as an MCP server: in the Grok Bot app, **Add a custom MCP** with the URL
`<public base>/api/v1/mcp` and an `Authorization` header holding a connector token (`pnpm grokbot mcp` issues one,
prints the URL and copies `Bearer …` to the clipboard; `POST /agents/:id/mcp-token` does the same over the API).
Streamable HTTP with plain JSON answers and no sessions; `initialize`, `ping`, `tools/list`, `tools/call`. One token
per agent (a new one revokes the old), 30 days, revocable (`DELETE /agents/:id/mcp-token`). Calls inside an open
job act for the person who asked for it and join its chain (Grok Bot passes `task_id`; otherwise the agent's newest
open job); outside a job they act for the member who issued the token. Same tool set and checks as the webhook API.
`pnpm grokbot mcp-check` proves the endpoint over the public URL with a throwaway token.

### Live eval

`pnpm grokbot:eval [agent] [case …]` sends real jobs to the agent's Grok Bot one at a time and checks what it
actually did (recorded tool calls, mentions, money, the result): reading proposals and balances, the team, asking a
person, handing work to another agent and getting its answer back, a refused payment, staying quiet when all is
fine, the self-mention guard, one paid API call, a funding request (on Grok Bot and on our own loop), a Gateway top-up, an
Earn deposit, and a refused loan. Jobs on our own loop record their tool calls on the task the same way.
On 2026-11-15 the five new cases passed 24/24 checks (Gateway and Earn first ran into Clerk's $0.50 daily budget, which
the earlier live tests had used up: refused correctly, then passed on a rerun with the budget raised for that run). It writes a Markdown report to `~/Desktop/research/cosign/`.

## Voice (ElevenLabs)

Voice is the same agent as the chat, like ChatGPT's voice mode. ElevenLabs does the ears and the mouth
(microphone, speech-to-text, turn-taking, interruptions, the voice). Its **Custom LLM** setting points at
us, so every turn is answered by the normal Cosign loop: Grok, all of the agent's tools and checks, in the
person's own chat thread (type, then talk, then type). ElevenLabs has no tools and no model of its own here;
its fallback models are switched off, so nothing answers without our rules. One ElevenLabs agent per Cosign
agent, "Cosign: <name>", created by `pnpm voice setup`; ids and the post-call webhook secret (encrypted) live
in `data/elevenlabs.local.json`.

1. `POST /agents/:id/voice` (a member who may use the agent) opens a voice session: a task of kind `voice`
   with its own token (30 minutes). It returns a signed URL (the agent only starts from one) and the
   conversation's dynamic variables, including `secret__cosign_auth` (the token), which ElevenLabs puts only
   in a request header and never shows a model. It also starts the agent's microVM, so the first turn is quick.
2. Each turn is `POST /voice/llm/chat/completions` (OpenAI Chat Completions, streamed), token in `X-Cosign-Auth`.
   We take the newest thing the person said and run one turn in their thread with a short voice note (spoken
   sentences, no markdown, no full addresses); the answer is cleaned for speech as a backstop. Before each tool
   runs, the voice says what Grok is about to do in its own words: on voice turns every tool takes a required
   `say_first` sentence ("I'll run the vendor check on Lena now."), written in the same reply that picks the
   tool (Grok won't send plain text alongside a tool call) and spoken the moment the call arrives; the tool never
   sees it. A call without one gets a canned line; at most three lines per turn; a turn with nothing said after
   3 seconds gets "One moment please...". Voice only: the chat shows its steps instead. ElevenLabs retries a slow request (it waits up
   to 15 s): a retry joins the turn already running, or gets its saved answer, so a turn never runs twice.
   Errors are spoken ("Sorry, something went wrong...") and the call carries on. Silence (ElevenLabs sends
   "...") gets ElevenLabs' `skip_turn` (Clerk stays quiet until the person speaks), with no model turn and
   nothing in the thread. Speculative turns are off: a turn can draft a payment, so only finished sentences
   reach it. Spoken turns are marked
   `via: "voice"` in the thread; tool calls and turns also go on the session's progress.
3. A draft made by voice emits `proposal.drafted` with the session id (see Live feed), so the page in that
   call opens the cosign card. The model never decides what appears on screen.
4. When the call ends, ElevenLabs' HMAC-signed post-call webhook (`POST /voice/webhook`) closes the
   session with its summary, and the token stops working. Retries are harmless.

The webhook's URL can't be edited, so `pnpm voice setup` creates a new one when the public URL changes and
disables the old one. Tested live on 2026-11-13: "What's waiting for a cosign?" → `list_proposals` → "Proposal
four for two dollars forty to Lena is waiting for a cosign" (about 10 s with the tool call); a draft to a
non-contact was declined.

## Schedules

Stored here (`POST /agents/:id/schedules` with `{every: hour|day|week, minute, hour, weekday}` in UTC).
`POST /cron/tick` with `x-cron-secret: $CRON_SECRET` runs due ones (Vercel Cron in production,
`scripts/scheduler.ts` locally). A schedule moves to its next time before it runs, so it never fires twice,
and runs only while its creator can still use the agent.

## Running

```bash
pnpm dev
pnpm tsx --env-file=.env.local scripts/seed-demo.ts   # demo treasury → "Nova Labs" workspace (COSIGN_OWNER_ADDRESS adds your wallet)
pnpm tsx --env-file=.env.local scripts/scheduler.ts   # optional: local cron
```

Grok Bot from the terminal (acts as the demo Test CFO; needs a public URL, PUBLIC_BASE_URL or a running ngrok tunnel):

```bash
pnpm grokbot setup                      # copies the setup message; paste it into one Bot's own chat
pnpm grokbot connect                    # reads the Webhook URL, then the Key, from the clipboard; pings
pnpm grokbot task "Check our balances"  # one task, with live progress
pnpm grokbot status
```

Voice from the terminal (needs `ELEVENLABS_API_KEY`; run setup again when the public URL changes):

```bash
pnpm voice setup        # the agent "Cosign: Clerk" on ElevenLabs (brain = our endpoint) and its post-call webhook
pnpm voice try Clerk "What's waiting for a cosign?"   # a real conversation through ElevenLabs, typed instead of spoken
pnpm voice test         # one 2-hour test session for the dashboard's test calls (reload the agent page once), until Ctrl-C
pnpm voice logs Clerk 3  # ElevenLabs' record of the last 3 calls: transcript, time to first sound and full answer, why it ended
pnpm voice status
```

`.env.local` needs `COSIGN_SECRET` and `CRON_SECRET` besides the Circle, xAI and QuickNode keys
(`PUBLIC_BASE_URL` when Grok Bot must reach a tunnel or deploy; `ELEVENLABS_API_KEY` for voice).

The database is `~/.cosign/cosign.db` (`COSIGN_DB` overrides it), outside the project folder on purpose: the dev
server's file watcher (Turbopack, in the same process) reads changed files in the project, and on macOS any open and
close of the file by other code in a process drops that process's SQLite locks. The server would then hold the
database without its locks, and the next script to exit (`pnpm grokbot`, `pnpm voice`, the evals) would delete the
write-ahead log under it. Outside the watched folder, scripts can run while the server runs. The split guard stays:
if the log is ever deleted or replaced under the server, it stops at once without writing the stale log back.

## Tests

- `pnpm test:unit`: 69 tests, no network: the wallet send, swap, bridge, Gateway, Earn and borrow checks, `request_funds`, the MCP endpoint, team mentions and their guards, roles, agent access, rules and loosening, all seven controls
  against a throwaway database, wallet sign-in, the checked tool runner, schedule times, secret encryption,
  the `proposal.drafted` event, `list_allowed`, voice (silence via `skip_turn`, the ElevenLabs agent config, the streamed turn format, "One moment",
  retries never running a turn twice, spoken errors, speech cleanup, post-call signatures and webhook).
- `pnpm test:browser`: 7 Playwright specs, one per wired part, in the system's Chrome with an injected throwaway
  wallet (see [frontend.md](frontend.md#browser-tests)).
- `pnpm test:e2e`: 23 tests against the running app on Arc testnet with real throwaway wallets: sign-in,
  creating a company onchain, invites, roles, contacts, agents, controls, onchain setup, chat over SSE
  (Grok), cosigning, adding an approver, Grok Bot connect / tasks / tokens (a mock routine), schedules,
  our own loop, freeze, sweep, retire. About 0.6 testnet USDC and a few cents of Grok per run.

## Endpoints

```
GET    /api/v1/auth/nonce
POST   /api/v1/auth/verify
POST   /api/v1/auth/logout
GET    /api/v1/me
POST   /api/v1/workspaces/prepare                  createTreasury tx for the creator's wallet
POST   /api/v1/workspaces                          register { name, txHash | treasury }
GET    /api/v1/workspaces/:ws
GET    /api/v1/workspaces/:ws/members
POST   /api/v1/workspaces/:ws/members              invite { address, roleId, title }
PATCH  /api/v1/workspaces/:ws/members/:mid
DELETE /api/v1/workspaces/:ws/members/:mid
GET    /api/v1/workspaces/:ws/roles
POST   /api/v1/workspaces/:ws/roles
PATCH  /api/v1/workspaces/:ws/roles/:rid
DELETE /api/v1/workspaces/:ws/roles/:rid
GET    /api/v1/workspaces/:ws/contacts
POST   /api/v1/workspaces/:ws/contacts
DELETE /api/v1/workspaces/:ws/contacts/:cid
GET    /api/v1/workspaces/:ws/proposals            ?status=open
GET    /api/v1/workspaces/:ws/proposals/:pid/cosign   approve tx for an onchain approver
GET    /api/v1/workspaces/:ws/proposals/:pid/cancel
POST   /api/v1/workspaces/:ws/approver-changes     { kind: add | remove | threshold, address, newThreshold }
GET    /api/v1/workspaces/:ws/approvals            ask-a-person purchase requests
POST   /api/v1/workspaces/:ws/approvals/:rid       { decision: approve | deny }
GET    /api/v1/workspaces/:ws/funding-requests     what agents asked to add to the treasury
POST   /api/v1/workspaces/:ws/funding-requests/:rid/decline   an approver says no (nothing is bought)
POST   /api/v1/workspaces/:ws/onramp               { requestId?, amountUsd? } → Circle onramp widget URL for the treasury
GET    /api/v1/workspaces/:ws/activity
GET    /api/v1/workspaces/:ws/activity/stream      SSE
POST   /api/v1/mcp                                    MCP (Grok Bot custom connector; connector token)
GET    /api/v1/agents/:ag/mcp-token                   connector token status
POST   /api/v1/agents/:ag/mcp-token                   issue a connector token (shown once)
DELETE /api/v1/agents/:ag/mcp-token                   revoke it
GET    /api/v1/workspaces/:ws/team                    people + agents you may use
GET    /api/v1/workspaces/:ws/team/messages           the team feed (@mentions and answers)
GET    /api/v1/workspaces/:ws/tasks
GET    /api/v1/workspaces/:ws/agents
GET    /api/v1/workspaces/:ws/spend                ?days=30: per day and per agent (the rows the limits read), last 7 days by kind
POST   /api/v1/workspaces/:ws/agents               { name, prompt, visibility, preset, allowedRoleIds, controls, hue }
GET    /api/v1/agents/:ag                          settings, balances, onchain status
GET    /api/v1/agents/:ag/spend                    ?days=30: per day, the last 24 h by kind, payments this hour
PATCH  /api/v1/agents/:ag                          { name, prompt, visibility, allowedRoleIds, abilities, controls }
POST   /api/v1/agents/:ag/freeze
POST   /api/v1/agents/:ag/unfreeze
POST   /api/v1/agents/:ag/sweep
POST   /api/v1/agents/:ag/retire
GET    /api/v1/agents/:ag/onchain                  txs for an approver to sign
POST   /api/v1/agents/:ag/chat                     SSE
GET    /api/v1/agents/:ag/thread
GET    /api/v1/agents/:ag/grokbot                  setup message + connection
POST   /api/v1/agents/:ag/grokbot                  { webhookUrl, webhookKey } → ping
DELETE /api/v1/agents/:ag/grokbot
POST   /api/v1/agents/:ag/tasks                    { instructions }
GET    /api/v1/tasks/:tid
GET    /api/v1/agents/:ag/schedules
POST   /api/v1/agents/:ag/schedules
PATCH  /api/v1/schedules/:sid                      { …, enabled, nextRunAt }
DELETE /api/v1/schedules/:sid
POST   /api/v1/cron/tick                           x-cron-secret
GET    /api/v1/bot/context                         Bearer task token
POST   /api/v1/bot/tools/:name                     Bearer task token, { args }
POST   /api/v1/bot/tasks/:tid/ack|progress|result  Bearer task token
GET    /api/v1/agents/:ag/voice                    voice set up?
POST   /api/v1/agents/:ag/voice                    open a voice session → signed URL + dynamic variables
POST   /api/v1/voice/llm/chat/completions          ElevenLabs custom LLM: one spoken turn (X-Cosign-Auth = voice session token)
POST   /api/v1/voice/webhook                       ElevenLabs post-call webhook (HMAC)
```
