# Cosign

**Your AI finance team drafts. You cosign.**

Cosign gives small teams an AI finance team that runs on stablecoins: agents draft payments,
pay for the services they use with tiny per-request payments, and keep the books, while the
company treasury only moves when a human approver cosigns onchain.

Built during the UBC 2026 Hackathon (Agentic Payments & AI track, Best use of Arc).

## Status

- [x] Circle developer-controlled wallets on Arc testnet, first USDC transfer
- [x] `TreasuryFactory` + `CompanyTreasury` contracts (propose → approve → pay, agent petty cash, approvers added or removed by cosign)
- [x] x402 payments: vanilla x402 and Circle Gateway Nanopayments, demo paid APIs that accept both
- [x] Grok agent: native loop on the xAI Responses API, a microVM sandbox per agent, linked-note memory, sessions with compaction
- [x] QuickNode Streams live treasury feed
- [x] Backend: wallet sign-in, workspaces, members invited by address, roles, agents with wallet controls, chat over SSE, Grok Bot webhook routines, schedules ([docs/backend.md](docs/backend.md))
- [ ] Dashboard (shadcn/ui, AI Elements, ElevenLabs voice)

## Local setup

```bash
pnpm install
cp .env.example .env.local   # fill in XAI_API_KEY, CIRCLE_*, QUICKNODE_*, COSIGN_SECRET, CRON_SECRET
pnpm tsx --env-file=.env.local scripts/01-setup-wallets.ts
pnpm dev
pnpm test:unit && pnpm test:e2e        # backend tests (e2e needs pnpm dev running)
```

The backend API, roles, agent controls, Grok Bot connection and tests are described in
[docs/backend.md](docs/backend.md).

Network: Arc testnet (chain id 5042002, RPC https://rpc.testnet.arc.io). Testnet USDC: https://faucet.circle.com

## QuickNode Streams: live treasury feed

Every payment an agent drafts, every cosign, every petty-cash draw and every USDC movement in or
out of a Cosign wallet reaches the app about a second after its block, through one QuickNode
Stream.

| Setting | Value |
|---|---|
| Stream | `cosign-arc-testnet` |
| Network | `arc-testnet` (chain id 5042002) |
| Dataset | `logs` |
| Filter | [`quicknode/stream-filter.js`](quicknode/stream-filter.js), generated from [`src/lib/quicknode/filter.ts`](src/lib/quicknode/filter.ts) |
| Address lists | QuickNode Key-Value Store: `cosign-treasuries`, `cosign-wallets` |
| Destination | Webhook → `POST /api/webhooks/quicknode` ([route](src/app/api/webhooks/quicknode/route.ts)) |
| Batch | 1 block per delivery, region `usa_east` |

### Filter logic

The filter runs on QuickNode for every block and returns `null` when nothing matches, so blocks
with no Cosign activity never cause a webhook call. It keeps three kinds of logs:

1. **New companies.** `TreasuryCreated` from our `TreasuryFactory`
   (`0xB794E55ed8b6833AF935c8a8bbD5B3b76f063D79`).
2. **Treasury events.** Any `CompanyTreasury` event (`ProposalCreated`, `ProposalApproved`,
   `ProposalCancelled`, `PaymentExecuted`, `AllowanceSet`, `AgentToppedUp`, `RoleUpdated`,
   `Paused`, `Unpaused`, `Deposited`, `ApproverChangeProposed`, `ApproverAdded`,
   `ApproverRemoved`, `ThresholdChanged`) emitted by an address in the `cosign-treasuries` list.
3. **USDC movements.** `Transfer` logs where the sender or receiver is in the `cosign-wallets` list
   (agent wallets, approvers, treasuries). Only the logs from Arc's system emitter
   `0xffff…fffe` are kept. That emitter logs every USDC movement, native or through the ERC-20
   interface, with 18-decimal amounts. The USDC contract `0x3600…0000` emits a second `Transfer`
   for ERC-20-interface transfers, and the filter drops it so nothing is counted twice.

The watched addresses live in QuickNode's Key-Value Store, not in the filter code. The filter
collects the candidate addresses in a block and checks them with one batched
`qnLib.qnContainsListItems` call per list. Adding a company or an agent is a list update and never
redeploys the stream. `createCompany` adds the new treasury right after its receipt, and the
webhook adds any treasury it sees created by the factory as a backstop.

### Destination

The webhook route:

- verifies `x-qn-signature` = HMAC-SHA256(security token, nonce + timestamp + body) and rejects
  timestamps more than 5 minutes off (401 on either failure; gzip bodies are accepted),
- decodes each log into a readable row ("Clerk drafted #2: $1.5 → Lena (contractor)"),
- stores it in SQLite, deduplicated on transaction hash + log index, so a retried delivery never
  double counts,
- answers 200 right away.

The app reads the feed from `GET /api/activity` and live from `GET /api/activity/stream`
(Server-Sent Events).

### Measured on Arc testnet (2026-11-13)

- QuickNode `test_filter` on 6 real blocks: QuickNode's output matched a local run of the same
  filter on every block, for both the embedded-address and the Key-Value Store versions.
- Live treasury flow: 9 events in 5 signed deliveries. Block to stored row: median 0.8 s, max
  1.3 s (12 events; block timestamps are whole seconds).
- A company created while the stream ran: its creation and first deposit arrived with no change to
  the stream.

### Run it

```bash
pnpm dev
ngrok http 3000
pnpm tsx --env-file=.env.local scripts/10-qn-stream.ts on https://<tunnel> 10  # starts at the chain tip, pauses itself after 10 min
pnpm tsx --env-file=.env.local scripts/02-treasury-demo.ts                    # live treasury flow
pnpm tsx --env-file=.env.local scripts/10-qn-stream.ts off
```

Other tests: `08` (signed deliveries against real blocks, no credits), `09` (QuickNode
`test_filter` vs local), `11` (new company picked up live).

Streams bill per block processed, and Arc makes about 170,000 blocks a day, so the stream stays
paused outside tests and demos. `on` moves the start to the chain tip each time, so a pause never
turns into a paid backfill.
