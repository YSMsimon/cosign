/**
 * Step 2 end-to-end on Arc testnet:
 * create company treasury -> fund it -> give the AP Clerk a petty-cash allowance ->
 * clerk tops up -> clerk proposes a vendor bill -> CFO cosigns -> paid.
 *
 * Run: pnpm tsx --env-file=.env.local scripts/02-treasury-demo.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Address } from "viem";
import {
  approvePayment, availableAllowance, createCompany, explorerAddr, explorerTx, fmt,
  proposePayment, sendUsdc, setAgentAllowance, topUpAgent, treasuryState, usdcBalance, wallet,
} from "../src/lib/arc";

const STORE = "data/treasury.local.json";

(async () => {
  const cfo = wallet("test-cfo");
  const clerk = wallet("agent-ap-clerk");
  const vendor = process.env.DEPLOYER_ADDRESS as Address; // stand-in "vendor" for the demo

  let treasury: Address;
  if (existsSync(STORE)) {
    treasury = JSON.parse(readFileSync(STORE, "utf8")).treasury;
    console.log(`Using existing treasury ${treasury}`);
  } else {
    const r = await createCompany("test-cfo", "Nova Labs (demo)", [cfo.address], [clerk.address], 1);
    treasury = r.treasury;
    writeFileSync(STORE, JSON.stringify({ treasury, createdTx: r.hash }, null, 2));
    console.log(`1. Company created: ${explorerAddr(treasury)}\n   tx ${explorerTx(r.hash)}`);
  }

  const fund = await sendUsdc("test-cfo", treasury, "5");
  console.log(`2. CFO funded treasury with 5 USDC: ${explorerTx(fund)}`);

  const allow = await setAgentAllowance("test-cfo", treasury, clerk.address, "2", 7 * 24 * 3600);
  console.log(`3. AP Clerk petty-cash allowance = 2 USDC / week: ${explorerTx(allow.hash)}`);

  const top = await topUpAgent("agent-ap-clerk", treasury, "1");
  console.log(`4. AP Clerk topped up 1 USDC itself (no approval): ${explorerTx(top.hash)}`);
  console.log(`   allowance left this week: ${await availableAllowance(treasury, clerk.address)} USDC`);

  const p = await proposePayment("agent-ap-clerk", treasury, vendor, "1.5", "Invoice #118 - design work");
  console.log(`5. AP Clerk proposed paying vendor 1.5 USDC (proposal #${p.id}): ${explorerTx(p.hash)}`);
  console.log(`   vendor balance before cosign: ${fmt(await usdcBalance(vendor))} USDC`);

  const a = await approvePayment("test-cfo", treasury, p.id);
  console.log(`6. CFO cosigned -> paid: ${explorerTx(a.hash)}`);
  console.log(`   vendor balance after cosign:  ${fmt(await usdcBalance(vendor))} USDC`);

  console.log("Treasury now:", await treasuryState(treasury));
})().catch((e) => {
  console.error("FAILED:", e?.response?.status ?? "", JSON.stringify(e?.response?.data ?? e?.message ?? String(e)));
  process.exit(1);
});
