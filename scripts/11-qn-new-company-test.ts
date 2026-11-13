/**
 * Live KV-list test (stream must be on): create a NEW company, fund it, and check its events reach
 * the feed without touching the stream (createCompany adds the treasury to the QuickNode KV list).
 * Run: pnpm tsx --env-file=.env.local scripts/11-qn-new-company-test.ts
 */
import { createCompany, explorerTx, sendUsdc, wallet } from "../src/lib/arc";

const APP = process.env.APP_URL ?? "http://localhost:3000";

(async () => {
  const cfo = wallet("test-cfo");
  const clerk = wallet("agent-ap-clerk");
  const c = await createCompany("test-cfo", "Watchlist Test Co", [cfo.address], [clerk.address], 1);
  console.log(`1. new company ${c.treasury} (${explorerTx(c.hash)})`);
  const kv = await fetch(`https://api.quicknode.com/kv/rest/v1/lists/cosign-treasuries`, { headers: { "x-api-key": process.env.QUICKNODE_API_KEY! } });
  const items = ((await kv.json()) as { data: { items: string[] } }).data.items;
  console.log(`2. KV list cosign-treasuries contains it: ${items.includes(c.treasury.toLowerCase())} (${items.length} treasuries)`);
  const fund = await sendUsdc("test-cfo", c.treasury, "0.1");
  console.log(`3. funded 0.1 USDC: ${explorerTx(fund)}`);
  const want = c.treasury.toLowerCase();
  for (let i = 0; i < 40; i++) {
    const feed = (await (await fetch(`${APP}/api/activity?limit=50`)).json()) as { activity: { treasury: string | null; counterparty: string | null; type: string; summary: string; blockNumber: number; blockTime: number | null; createdAt: string }[] };
    const mine = feed.activity.filter((a) => a.treasury?.toLowerCase() === want || a.counterparty?.toLowerCase() === want);
    if (mine.length >= 3) {
      console.log(`4. feed has ${mine.length} events for the new company (after ~${i}s):`);
      for (const a of mine) console.log(`   [${a.blockNumber}] ${a.type.padEnd(18)} ${a.summary}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("4. not all events arrived within 40 s");
})().catch((e) => {
  console.error("FAILED:", JSON.stringify(e?.response?.data ?? e?.message ?? String(e)));
  process.exit(1);
});
