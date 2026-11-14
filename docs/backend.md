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

`POST /agents/:id/chat {message}` streams Server-Sent Events: `step` for every loop event (Grok
thinking, web/X searches, tool calls with arguments, results, refusals), then `done` with the answer,
token use and cost. Each person has their own thread (`GET /agents/:id/thread`); memory is shared.

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

## Voice (ElevenLabs)

ElevenLabs runs the voice conversation (listening, turn-taking, speaking); its tools are webhook tools
that call us, like Grok Bot. One ElevenLabs agent per Cosign agent, "Cosign: <name>", created by
`pnpm voice setup`; ids and the post-call webhook secret (encrypted) live in `data/elevenlabs.local.json`.

1. `POST /agents/:id/voice` (a member who may use the agent) opens a voice session: a task of kind
   `voice` with its own token (30 minutes). It returns a signed URL (the agent only starts from one) and
   the conversation's dynamic variables: the agent's job and rules narrowed to that member, and
   `secret__cosign_auth`, which ElevenLabs puts only in the tool request header, never in the LLM's context.
2. Each tool call is `POST /voice/tools/{name}` with that token and the arguments as the JSON body.
   Same checks as the chat, under the member's rights. A refusal answers 200 `{ ok: false, refused }`
   so the agent can say why. Tools: balances, `list_proposals`, the x402 ones, drafting, top-up, memory.
   `open_cosign` is a client tool the page handles: it shows the cosign card; the wallet signs.
3. When the call ends, ElevenLabs' HMAC-signed post-call webhook (`POST /voice/webhook`) closes the
   session, keeps the summary and transcript on the task, and the token stops working. Retries are harmless.

The webhook's URL can't be edited, so `pnpm voice setup` creates a new one when the public URL changes
and disables the old one.

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
pnpm voice setup        # tools, post-call webhook and the agent "Cosign: Clerk" on ElevenLabs
pnpm voice test         # opens a session and loads it into the agent's test values; talk in the ElevenLabs dashboard
pnpm voice status
```

`.env.local` needs `COSIGN_SECRET` and `CRON_SECRET` besides the Circle, xAI and QuickNode keys
(`PUBLIC_BASE_URL` when Grok Bot must reach a tunnel or deploy; `ELEVENLABS_API_KEY` for voice).

Only one process should hold `data/cosign.db` for long. If its write-ahead log is ever deleted or
replaced under a running process, that process stops itself at once (without closing the database,
so the stale log is never copied back). Back up `data/` and restart.

## Tests

- `pnpm test:unit`: 32 tests, no network: roles, agent access, rules and loosening, all seven controls
  against a throwaway database, wallet sign-in, the checked tool runner, schedule times, secret encryption,
  voice (post-call signatures, tool configs, session tokens, the post-call webhook).
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
GET    /api/v1/workspaces/:ws/activity
GET    /api/v1/workspaces/:ws/activity/stream      SSE
GET    /api/v1/workspaces/:ws/tasks
GET    /api/v1/workspaces/:ws/agents
POST   /api/v1/workspaces/:ws/agents               { name, prompt, visibility, preset, allowedRoleIds, controls }
GET    /api/v1/agents/:ag                          settings, balances, onchain status
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
POST   /api/v1/voice/tools/:name                   Bearer voice session token, body = the tool's arguments
POST   /api/v1/voice/webhook                       ElevenLabs post-call webhook (HMAC)
```
