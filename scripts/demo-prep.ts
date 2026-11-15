/**
 * Get the demo company ready to record (Nova Labs, its Clerk). Shows what it finds; with --apply it fixes it:
 *   0. tops up Clerk's own wallet from the demo CFO when it's nearly empty (USDC is Arc's gas, and it pays per request),
 *   1. cancels open treasury proposals drafted by our own agents (test drafts; nothing is paid, the record stays
 *      onchain), signed by the demo CFO, an approver,
 *   2. gives Clerk room in its wallet budget for the demo (raises its daily/weekly/monthly purchase limits, never lowers),
 *   3. makes sure Clerk can draw petty cash now: its weekly allowance onchain matches its setting, raised (both) when it
 *      already drew this period's amount (signed by the demo CFO).
 *
 *   pnpm exec tsx --env-file=.env.local scripts/demo-prep.ts            what it would do
 *   pnpm exec tsx --env-file=.env.local scripts/demo-prep.ts --apply    do it (then: sh node_modules/.cosign-tmp/walcheck.sh)
 */
import { and, eq } from "drizzle-orm";
import type { Address } from "viem";
import { companyTreasuryAbi } from "../src/lib/contracts/abis";
import { availableAllowance, callFrom, chain, findWallet, fmt, readProposal, sendUsdc, setAgentAllowance, usdcBalance, wallet, wallets } from "../src/lib/arc";
import { db, schema } from "../src/lib/db";
import { mergeControls, type Controls } from "../src/lib/agent/rules";
import { agentSpend } from "../src/lib/server/spend";

const APPLY = process.argv.includes("--apply");
const COMPANY = process.env.DEMO_COMPANY ?? "Nova Labs";
const AGENT_REF = process.env.DEMO_AGENT_REF ?? "agent-ap-clerk";
const APPROVER_REF = process.env.DEMO_APPROVER_REF ?? "test-cfo";
const DEMO_LIMITS = { daily: 2, weekly: 5, monthly: 10 }; // room for the demo's paid calls, sends and swaps
const WEEK = 7 * 24 * 3600;
const WALLET_FLOOR = 0.5; // top Clerk's wallet up below this
const WALLET_TOPUP = "1.0";
const DEMO_PETTY_CASH = 2; // petty cash Clerk should be able to draw during the demo

void (async () => {
  const ws = db().select().from(schema.workspaces).where(eq(schema.workspaces.name, COMPANY)).get();
  if (!ws) throw new Error(`no workspace called "${COMPANY}"`);
  const agent = db().select().from(schema.agents).where(and(eq(schema.agents.workspaceId, ws.id), eq(schema.agents.ref, AGENT_REF))).get();
  if (!agent) throw new Error(`no agent ${AGENT_REF} in ${COMPANY}`);
  const t = ws.treasury as Address;
  const clerk = agent.walletAddress as Address;
  const controls = JSON.parse(agent.controls) as Controls;
  console.log(`${COMPANY} · treasury ${t} · ${APPLY ? "APPLYING" : "dry run (add --apply to fix)"}\n`);

  // balances
  const [inTreasury, inWallet, allowanceLeft] = await Promise.all([usdcBalance(t), usdcBalance(clerk), availableAllowance(t, clerk)]);
  console.log(`treasury ${fmt(inTreasury)} USDC · ${agent.name}'s wallet ${fmt(inWallet)} USDC · petty cash left this week ${allowanceLeft} of $${controls.pettyCashPerWeekUsd}`);

  // 0. Clerk's own wallet
  const cfoBalance = await usdcBalance(wallet(APPROVER_REF).address);
  console.log(`\n0. ${agent.name}'s wallet: ${fmt(inWallet)} USDC (the demo CFO has ${fmt(cfoBalance)})`);
  if (Number(fmt(inWallet)) < WALLET_FLOOR) {
    console.log(`   → send ${WALLET_TOPUP} USDC from ${APPROVER_REF}`);
    if (APPLY) console.log(`   sent · ${await sendUsdc(APPROVER_REF, clerk, WALLET_TOPUP)}`);
  } else console.log("   enough");

  // 1. open proposals drafted by our own wallets
  const ours = new Map<string, string>();
  for (const w of wallets()) ours.set(w.address.toLowerCase(), w.refId);
  for (const a of db().select().from(schema.agents).where(eq(schema.agents.workspaceId, ws.id)).all()) {
    if (a.walletAddress && findWallet(a.ref)) ours.set(a.walletAddress.toLowerCase(), a.ref);
  }
  const count = Number(await chain.readContract({ address: t, abi: companyTreasuryAbi, functionName: "proposalCount" }));
  const open: { id: number; amount: string; memo: string; ref?: string; proposer: string }[] = [];
  for (let i = 0; i < count; i++) {
    const p = await readProposal(t, BigInt(i));
    if (p.executed || p.cancelled) continue;
    open.push({ id: i, amount: fmt(p.amount), memo: p.memo, proposer: p.proposer, ref: ours.get(p.proposer.toLowerCase()) });
  }
  console.log(`\n1. open proposals: ${open.length}`);
  for (const p of open) console.log(`   #${p.id} $${p.amount} "${p.memo}" · drafted by ${p.ref ?? p.proposer}${p.ref ? "" : " (not ours: left alone)"}`);
  if (APPLY) {
    for (const p of open.filter((x) => x.ref)) {
      try {
        const { hash } = await callFrom(APPROVER_REF, t, companyTreasuryAbi, "cancel", [BigInt(p.id)]); // any approver may cancel
        console.log(`   cancelled #${p.id} · ${hash}`);
      } catch (e) {
        console.log(`   couldn't cancel #${p.id}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  }

  // 2. Clerk's wallet budget
  const spent = agentSpend(agent.id, 7);
  const lim = controls.purchases;
  console.log(`\n2. ${agent.name}'s wallet spend in the last 24 h: $${spent.last24h.purchases} of $${lim.daily} a day ($${lim.weekly} a week, $${lim.monthly} a month)`);
  const next = {
    daily: Math.max(lim.daily ?? 0, DEMO_LIMITS.daily),
    weekly: Math.max(lim.weekly ?? 0, DEMO_LIMITS.weekly),
    monthly: Math.max(lim.monthly ?? 0, DEMO_LIMITS.monthly),
  };
  if (next.daily !== lim.daily || next.weekly !== lim.weekly || next.monthly !== lim.monthly) {
    console.log(`   → limits $${next.daily} a day, $${next.weekly} a week, $${next.monthly} a month (per payment stays $${lim.perPayment})`);
    if (APPLY) {
      const merged = mergeControls(controls, { purchases: { ...lim, ...next } });
      db().update(schema.agents).set({ controls: JSON.stringify(merged), updatedAt: new Date().toISOString() }).where(eq(schema.agents.id, agent.id)).run();
      console.log("   saved");
    }
  } else console.log("   enough room already");

  // 3. the weekly petty-cash allowance onchain. Setting it doesn't reset what was drawn this period, so when Clerk has
  //    already drawn it all, the weekly amount goes up (setting and onchain together, so Permissions shows no sync
  //    warning) to leave DEMO_PETTY_CASH to draw now.
  const [perPeriod, period, start, spentRaw] = (await chain.readContract({ address: t, abi: companyTreasuryAbi, functionName: "agentAllowance", args: [clerk] })) as readonly [bigint, bigint, bigint, bigint];
  const rolled = Date.now() / 1000 >= Number(start + period);
  const spentNow = rolled ? 0 : Number(spentRaw) / 1e6;
  const setting = controls.pettyCashPerWeekUsd ?? 0;
  const onchain = Number(perPeriod) / 1e6;
  const left = Math.max(0, onchain - spentNow);
  const target = Math.max(setting, spentNow + DEMO_PETTY_CASH);
  console.log(`\n3. petty cash: $${onchain} a week onchain (setting $${setting}), $${spentNow} drawn this period, $${left} left; renews ${new Date(Number(start + period) * 1000).toISOString()}`);
  if (left + 1e-9 < DEMO_PETTY_CASH) {
    console.log(`   → $${target} a week, setting and onchain (signed by ${APPROVER_REF}), so $${target - spentNow} is left now`);
    if (APPLY) {
      if (target !== setting) {
        const merged = mergeControls(JSON.parse(db().select().from(schema.agents).where(eq(schema.agents.id, agent.id)).get()!.controls), { pettyCashPerWeekUsd: target });
        db().update(schema.agents).set({ controls: JSON.stringify(merged), updatedAt: new Date().toISOString() }).where(eq(schema.agents.id, agent.id)).run();
      }
      const { hash } = await setAgentAllowance(APPROVER_REF, t, clerk, String(target), Number(period) || WEEK);
      console.log(`   set · ${hash}`);
    }
  } else console.log("   enough");
})().catch((e) => {
  console.error("demo prep failed:", (e as Error).message);
  process.exit(1);
});
