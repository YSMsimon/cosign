/**
 * Step 3 test: the Clerk agent pays $0.01 (x402, Circle-signed EIP-3009) and gets data back.
 * Needs the dev server running:  pnpm dev
 * Run:                            pnpm tsx --env-file=.env.local scripts/03-paid-fetch-demo.ts
 */
import { explorerTx, fmt, usdcBalance, wallet } from "../src/lib/arc";
import { paidFetch, PolicyRefusal } from "../src/lib/x402/buyer";

const BASE = process.env.APP_URL ?? "http://localhost:3000";
const policy = { maxPerCallUsd: 0.05, allowedHosts: [`${new URL(BASE).host}/api/sellers`] };

(async () => {
  const clerk = wallet("agent-ap-clerk");
  const seller = process.env.SELLER_ADDRESS as `0x${string}`;
  console.log(`Clerk ${clerk.address}: ${fmt(await usdcBalance(clerk.address))} USDC | seller ${fmt(await usdcBalance(seller))} USDC`);

  // 1. unpaid request -> 402
  const raw = await fetch(`${BASE}/api/sellers/invoice-reader?invoice=118`);
  console.log(`1. GET without payment -> HTTP ${raw.status} (PAYMENT-REQUIRED header: ${raw.headers.has("payment-required")})`);

  // 2. agent pays $0.01 and gets the data
  const r = await paidFetch("agent-ap-clerk", `${BASE}/api/sellers/invoice-reader?invoice=118`, policy);
  console.log(`2. paidFetch -> HTTP ${r.status}`, JSON.stringify(r.data));
  if (r.paid) console.log(`   paid $${r.paid.amountUsd} to ${r.paid.payTo}${r.paid.transaction ? `\n   ${explorerTx(r.paid.transaction)}` : ""}`);

  // 3. policy refusal: a $0.02 call with a $0.015 cap is refused before anything is signed
  try {
    await paidFetch("agent-ap-clerk", `${BASE}/api/sellers/vendor-check?address=${seller}`, { ...policy, maxPerCallUsd: 0.015 });
  } catch (e) {
    if (e instanceof PolicyRefusal) console.log(`3. refused by policy (nothing signed): ${e.message}`);
    else throw e;
  }

  console.log(`After: Clerk ${fmt(await usdcBalance(clerk.address))} USDC | seller ${fmt(await usdcBalance(seller))} USDC`);
})().catch((e) => {
  console.error("FAILED:", e?.response?.status ?? "", JSON.stringify(e?.response?.data ?? e?.message ?? String(e)));
  process.exit(1);
});
