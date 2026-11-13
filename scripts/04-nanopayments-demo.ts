/**
 * Nanopayments test (Circle Gateway, Arc testnet), with a REAL outside seller:
 *  1. discover paid services on Arc testnet through Circle's Discovery API
 *  2. make sure the Clerk has a Gateway balance (one-time approve + deposit)
 *  3. Clerk pays QuickNode's x402 RPC ($0.0001) and gets the latest Arc block number back
 *  4. policy refusal on a non-allowlisted host
 * Run: pnpm tsx --env-file=.env.local scripts/04-nanopayments-demo.ts
 */
import { explorerTx, fmt, usdcBalance, wallet } from "../src/lib/arc";
import { paidFetch, PolicyRefusal } from "../src/lib/x402/buyer";
import { discoverServices } from "../src/lib/x402/discovery";
import { ensureGatewayBalance, gatewayBalance } from "../src/lib/x402/gateway";

const QUICKNODE_ARC = "https://x402.quicknode.com/arc-testnet/";
const policy = { maxPerCallUsd: 0.01, allowedHosts: ["x402.quicknode.com", "localhost"] };
const rpc = (method: string, params: unknown[] = []) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
});

(async () => {
  const clerk = wallet("agent-ap-clerk");

  // 1. discovery
  const services = await discoverServices({ limit: 100 });
  const byProvider = new Map<string, { url: string; price: string; rail: string }>();
  for (const s of services) {
    const key = s.provider || new URL(s.url).hostname;
    if (!byProvider.has(key)) byProvider.set(key, { url: s.url, price: s.arcOptions[0].priceUsd, rail: s.arcOptions[0].rail });
  }
  console.log(`1. Discovery: ${services.length} paid endpoints on Arc testnet from ${byProvider.size} providers`);
  for (const [p, v] of byProvider) console.log(`   - ${p}: ${v.url} ($${v.price}, ${v.rail})`);

  // 2. Gateway balance (one-time deposit)
  console.log(`2. Clerk wallet ${fmt(await usdcBalance(clerk.address))} USDC | Gateway ${await gatewayBalance(clerk.address)} USDC`);
  const g = await ensureGatewayBalance("agent-ap-clerk", 0.05, "0.5");
  if (g.deposited) console.log(`   deposited 0.5 USDC into Gateway:\n   approve ${explorerTx(g.deposited.approveTx)}\n   deposit ${explorerTx(g.deposited.depositTx)}`);
  console.log(`   Gateway balance now ${g.balance} USDC`);

  // 3. pay a real outside seller
  const before = await gatewayBalance(clerk.address);
  const r = await paidFetch("agent-ap-clerk", QUICKNODE_ARC, policy, rpc("eth_blockNumber"));
  const block = typeof r.data === "object" && r.data && "result" in r.data ? parseInt(String((r.data as { result: string }).result), 16) : null;
  console.log(`3. QuickNode RPC (paid via ${r.paid?.rail ?? "none"}) -> HTTP ${r.status} | latest Arc block = ${block ?? JSON.stringify(r.data)}`);
  if (r.paid) console.log(`   paid $${r.paid.amountUsd} to ${r.paid.payTo} | nonce ${r.paid.nonce?.slice(0, 18)}… | receipt ${JSON.stringify(r.paid.receipt ?? {})}`);
  await new Promise((res) => setTimeout(res, 4000));
  console.log(`   Gateway balance ${before} -> ${await gatewayBalance(clerk.address)} USDC (batch settlement happens later)`);

  // 4. policy refusal
  try {
    await paidFetch("agent-ap-clerk", "https://api.botpay.network/pay", policy);
  } catch (e) {
    if (e instanceof PolicyRefusal) console.log(`4. refused by policy (nothing signed): ${e.message}`);
    else console.log(`4. other error: ${(e as Error).message}`);
  }
})().catch((e) => {
  console.error("FAILED:", e?.response?.status ?? "", JSON.stringify(e?.response?.data ?? e?.message ?? String(e)));
  process.exit(1);
});
