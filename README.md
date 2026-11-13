# Cosign

**Your AI finance team drafts. You cosign.**

Cosign gives small teams an AI finance team that runs on stablecoins: agents draft payments,
pay for the services they use with tiny per-request payments, and keep the books, while the
company treasury only moves when a human approver cosigns onchain.

Built during the UBC 2026 Hackathon (Agentic Payments & AI track, Best use of Arc).

## Status

- [x] Step 1: Circle developer-controlled wallets on Arc testnet, first USDC transfer
- [ ] Step 2: `TreasuryFactory` + `CompanyTreasury` contracts (propose → approve → pay, agent allowances)
- [ ] Step 3: x402 / Circle Nanopayments for per-request agent payments
- [ ] Step 4: Grok agent (AI SDK + xAI) with payment tools, MCP server for Grok Bot
- [ ] Step 5: Dashboard (shadcn/ui, AI Elements, ElevenLabs voice), QuickNode Streams feed

## Local setup

```bash
pnpm install
cp .env.example .env.local   # fill in XAI_API_KEY, CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET
pnpm tsx --env-file=.env.local scripts/01-setup-wallets.ts
pnpm dev
```

Network: Arc testnet (chain id 5042002, RPC https://rpc.testnet.arc.io). Testnet USDC: https://faucet.circle.com
