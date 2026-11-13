/**
 * Our demo paid APIs now accept BOTH rails. Needs `pnpm dev` running.
 *  1. unpaid request -> 402 offering GatewayWalletBatched + vanilla exact on Arc testnet
 *  2. Clerk pays the invoice reader via Gateway Nanopayments ($0.01 from its Gateway balance)
 *  3. Clerk pays the vendor check via vanilla x402 (preferGateway: false) ($0.02 onchain)
 * Run: pnpm tsx --env-file=.env.local scripts/05-seller-rails-demo.ts
 */
import { explorerTx, fmt, usdcBalance, wallet } from "../src/lib/arc";
import { paidFetch } from "../src/lib/x402/buyer";
import { gatewayBalance } from "../src/lib/x402/gateway";
import { decodeHeader, type PaymentRequired } from "../src/lib/x402/shared";

const BASE = process.env.APP_URL ?? "http://localhost:3000";
const policy = { maxPerCallUsd: 0.05, allowedHosts: ["localhost"] };

(async () => {
  const clerk = wallet("agent-ap-clerk");
  const seller = process.env.SELLER_ADDRESS as `0x${string}`;
  const snap = async () =>
    `Clerk wallet ${fmt(await usdcBalance(clerk.address))} | Clerk Gateway ${await gatewayBalance(clerk.address)} | seller wallet ${fmt(await usdcBalance(seller))} | seller Gateway ${await gatewayBalance(seller)}`;
  console.log("Before:", await snap());

  const raw = await fetch(`${BASE}/api/sellers/invoice-reader?invoice=120`);
  const offer = decodeHeader<PaymentRequired>(raw.headers.get("payment-required")!);
  console.log(`1. unpaid -> HTTP ${raw.status}; accepts: ${offer.accepts.map((a) => `${a.extra.name}@$${Number(a.amount) / 1e6}`).join(" | ")}`);

  const g = await paidFetch("agent-ap-clerk", `${BASE}/api/sellers/invoice-reader?invoice=120`, policy);
  console.log(`2. invoice reader via ${g.paid?.rail} -> HTTP ${g.status}`, JSON.stringify(g.data));
  console.log(`   receipt ${JSON.stringify(g.paid?.receipt ?? {})}`);

  const v = await paidFetch("agent-ap-clerk", `${BASE}/api/sellers/vendor-check?address=0x7797B992389e4a03E366DAEa33E71c0a394Df1e7`, {
    ...policy,
    preferGateway: false,
  });
  console.log(`3. vendor check via ${v.paid?.rail} -> HTTP ${v.status}`, JSON.stringify(v.data));
  if (v.paid?.transaction) console.log(`   ${explorerTx(v.paid.transaction)}`);

  await new Promise((r) => setTimeout(r, 4000));
  console.log("After: ", await snap());
})().catch((e) => {
  console.error("FAILED:", e?.response?.status ?? "", JSON.stringify(e?.response?.data ?? e?.message ?? String(e)));
  process.exit(1);
});
