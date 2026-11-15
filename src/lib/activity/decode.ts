/**
 * Decode Stream events into readable activity rows. Server-only.
 * Amounts: treasury events use USDC's 6-decimal ERC-20 units; Arc's system-emitter Transfer uses
 * the native 18-decimal amount (verified on our own transactions).
 */
import { readFileSync, existsSync } from "node:fs";
import { decodeEventLog, formatUnits, type Hex } from "viem";
import { companyTreasuryAbi, treasuryFactoryAbi, TREASURY_FACTORY_ADDRESS } from "../contracts/abis";
import { db, schema } from "../db";
import type { NewActivity } from "../db/schema";
import { ARC_SYSTEM_EMITTER, TRANSFER_TOPIC } from "../quicknode/filter";

export type StreamLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string | number;
  blockTimestamp?: string | number | null;
  transactionHash: string;
  logIndex: string | number;
};

const num = (v: string | number | null | undefined) => (v == null ? null : typeof v === "number" ? v : Number(BigInt(v)));
const usd6 = (v: bigint) => formatUnits(v, 6);
const usd18 = (v: bigint) => formatUnits(v, 18);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Known names for addresses: our wallets, each company's treasury, agents and saved contacts. */
export function addressBook(): Map<string, string> {
  const m = new Map<string, string>();
  const add = (a: string | undefined, name: string) => a && m.set(a.toLowerCase(), name);
  if (existsSync("data/wallets.local.json")) {
    for (const w of JSON.parse(readFileSync("data/wallets.local.json", "utf8")).wallets as { address: string; name: string }[]) add(w.address, w.name);
  }
  if (existsSync("data/treasury.local.json")) add(JSON.parse(readFileSync("data/treasury.local.json", "utf8")).treasury, "Nova Labs treasury");
  try {
    for (const w of db().select({ name: schema.workspaces.name, treasury: schema.workspaces.treasury }).from(schema.workspaces).all()) add(w.treasury, `${w.name} treasury`);
    for (const a of db().select({ name: schema.agents.name, wallet: schema.agents.walletAddress }).from(schema.agents).all()) add(a.wallet ?? undefined, a.name);
    for (const c of db().select({ name: schema.contacts.name, address: schema.contacts.address }).from(schema.contacts).all()) add(c.address, c.name);
  } catch {
    /* no database here: the file-based names still apply */
  }
  add(process.env.SELLER_ADDRESS, "Demo API seller");
  add("0x0077777d7EBA4688BDeF3E311b846F25870A19B9", "Circle Gateway");
  add(TREASURY_FACTORY_ADDRESS, "Treasury factory");
  return m;
}

export function decodeStreamLog(log: StreamLog, names = addressBook()): NewActivity | null {
  const label = (a: string) => names.get(a.toLowerCase()) ?? short(a);
  const base = {
    txHash: log.transactionHash.toLowerCase(),
    logIndex: num(log.logIndex) ?? 0,
    blockNumber: num(log.blockNumber) ?? 0,
    blockTime: num(log.blockTimestamp ?? null),
    raw: JSON.stringify(log),
    source: "quicknode",
    createdAt: new Date().toISOString(),
  };
  const addr = log.address.toLowerCase();
  const topics = log.topics as [Hex, ...Hex[]];

  // USDC movement (Arc system emitter, 18-decimal native amount)
  if (addr === ARC_SYSTEM_EMITTER && topics[0] === TRANSFER_TOPIC) {
    const from = `0x${topics[1].slice(26)}`;
    const to = `0x${topics[2].slice(26)}`;
    const amount = usd18(BigInt(log.data));
    return { ...base, type: "usdc_transfer", actor: from, counterparty: to, amountUsd: amount, summary: `$${amount} USDC: ${label(from)} → ${label(to)}` };
  }

  if (addr === TREASURY_FACTORY_ADDRESS.toLowerCase()) {
    try {
      const ev = decodeEventLog({ abi: treasuryFactoryAbi, data: log.data as Hex, topics });
      if (ev.eventName === "TreasuryCreated") {
        const a = ev.args as { treasury: string; creator: string; name: string; threshold: number };
        return { ...base, type: "treasury_created", treasury: a.treasury, actor: a.creator, summary: `Company created: ${a.name} (needs ${a.threshold} cosign${a.threshold > 1 ? "s" : ""})` };
      }
    } catch {
      return null;
    }
  }

  let ev: { eventName: string; args: Record<string, unknown> };
  try {
    ev = decodeEventLog({ abi: companyTreasuryAbi, data: log.data as Hex, topics }) as never;
  } catch {
    return null;
  }
  const a = ev.args;
  const t = { ...base, treasury: addr };
  switch (ev.eventName) {
    case "ProposalCreated":
      return { ...t, type: "proposal_created", proposalId: String(a.id), actor: String(a.proposer), counterparty: String(a.to), amountUsd: usd6(a.amount as bigint), summary: `${label(String(a.proposer))} drafted #${a.id}: $${usd6(a.amount as bigint)} → ${label(String(a.to))} ("${a.memo}")` };
    case "ProposalApproved":
      return { ...t, type: "proposal_approved", proposalId: String(a.id), actor: String(a.approver), summary: `${label(String(a.approver))} cosigned #${a.id} (${a.approvals} approval${Number(a.approvals) > 1 ? "s" : ""})` };
    case "PaymentExecuted":
      return { ...t, type: "payment_executed", proposalId: String(a.id), counterparty: String(a.to), amountUsd: usd6(a.amount as bigint), summary: `Paid #${a.id}: $${usd6(a.amount as bigint)} → ${label(String(a.to))}` };
    case "ProposalCancelled":
      return { ...t, type: "proposal_cancelled", proposalId: String(a.id), actor: String(a.by), summary: `#${a.id} cancelled by ${label(String(a.by))}` };
    case "AllowanceSet":
      return { ...t, type: "allowance_set", counterparty: String(a.agent), amountUsd: usd6(a.perPeriod as bigint), summary: `Petty cash for ${label(String(a.agent))}: $${usd6(a.perPeriod as bigint)} every ${Number(a.period) / 86400} day(s)` };
    case "AgentToppedUp":
      return { ...t, type: "agent_topped_up", actor: String(a.agent), amountUsd: usd6(a.amount as bigint), summary: `${label(String(a.agent))} took $${usd6(a.amount as bigint)} petty cash ($${usd6(BigInt(a.spentInPeriod as bigint))} used this period)` };
    case "Deposited":
      return { ...t, type: "deposited", actor: String(a.from), amountUsd: usd6(a.amount as bigint), summary: `Treasury received $${usd6(a.amount as bigint)} from ${label(String(a.from))}` };
    case "Paused":
      return { ...t, type: "paused", actor: String(a.by), summary: `⚠️ Treasury paused by ${label(String(a.by))}` };
    case "Unpaused":
      return { ...t, type: "unpaused", actor: String(a.by), summary: `Treasury resumed by ${label(String(a.by))}` };
    case "ApproverChangeProposed": {
      const what = ["payment", "add approver", "remove approver", "set threshold"][Number(a.kind)] ?? "change";
      const who = Number(a.kind) === 3 ? "" : ` ${label(String(a.account))}`;
      const th = Number(a.newThreshold) ? ` (threshold → ${a.newThreshold})` : "";
      return { ...t, type: "approver_change_proposed", proposalId: String(a.id), actor: String(a.proposer), counterparty: Number(a.kind) === 3 ? null : String(a.account), summary: `${label(String(a.proposer))} proposed #${a.id}: ${what}${who}${th}` };
    }
    case "ApproverAdded":
      return { ...t, type: "approver_added", counterparty: String(a.account), summary: `${label(String(a.account))} is now an approver` };
    case "ApproverRemoved":
      return { ...t, type: "approver_removed", counterparty: String(a.account), summary: `${label(String(a.account))} is no longer an approver` };
    case "ThresholdChanged":
      return { ...t, type: "threshold_changed", summary: `Payments now need ${a.threshold} cosign${Number(a.threshold) > 1 ? "s" : ""}` };
    case "RoleUpdated":
      return { ...t, type: "role_updated", counterparty: String(a.account), summary: `Role ${a.enabled ? "granted to" : "removed from"} ${label(String(a.account))}` };
    default:
      return null;
  }
}
