/**
 * Grok Bot watches the chain. When the QuickNode Stream reports money moving for a company (a treasury payment
 * executed, or USDC coming into the treasury), a Grok Bot job starts for the agent that handles it: check the payment
 * against what it was for, or find out what the money in is, and hand anything wrong to a person or an agent. Its
 * result shows in the agent's chat as Grok Bot's turn, under a line for the onchain event.
 *
 * Only fresh events: the Stream's own rows, or rows read from Arc (the fallback while the Stream is paused) from the
 * last 10 minutes, so reading history never wakes it. Only agents with a connected Grok Bot routine; one job per
 * event; at most a few a minute per company. Server-only.
 */
import { and, eq } from "drizzle-orm";
import type { Address } from "viem";
import { readProposal } from "../arc";
import { db, schema } from "../db";
import type { ActivityRow, AgentRow } from "../db/schema";
import { connectionOf, publicBase, startTask } from "./grokbot";

const FRESH_SEC = 600;
const PER_WINDOW = 6; // jobs per company per window
const WINDOW_MS = 10 * 60_000;

const g = globalThis as unknown as { __cosignWatched?: Set<string>; __cosignWatchRate?: Map<string, number[]> };
const watched: Set<string> = (g.__cosignWatched ??= new Set<string>());
const rate: Map<string, number[]> = (g.__cosignWatchRate ??= new Map<string, number[]>());

const money = (x: string | null) => `$${Number(x ?? 0).toFixed(2)}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The agent to hand an event to: the one that drafted the payment, else any with a connected Grok Bot routine. */
function handlerFor(workspaceId: string, proposer?: string): AgentRow | null {
  const agents = db().select().from(schema.agents).where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.status, "active"))).all();
  const watching = agents.filter((a) => connectionOf(a.id)?.status === "connected");
  return (proposer && watching.find((a) => a.walletAddress?.toLowerCase() === proposer.toLowerCase())) || watching[0] || null;
}

function underLimit(workspaceId: string) {
  const now = Date.now();
  const recent = (rate.get(workspaceId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= PER_WINDOW) return false;
  rate.set(workspaceId, [...recent, now]);
  return true;
}

/** What Grok Bot is asked to do about one event; the first line is the event, as the chat shows it. */
async function jobFor(r: ActivityRow, treasury: string): Promise<{ instructions: string; proposer?: string } | null> {
  const seen = r.source === "quicknode" ? "seen by QuickNode" : "read from Arc";
  const tx = `transaction ${r.txHash}`;
  if (r.type === "payment_executed" && r.proposalId) {
    const p = await readProposal(treasury as Address, BigInt(r.proposalId)).catch(() => null);
    const memo = p?.memo ? ` (memo "${p.memo}")` : "";
    return {
      proposer: p?.proposer,
      instructions: [
        `Onchain · paid proposal #${r.proposalId}: ${money(r.amountUsd)} to ${short(String(r.counterparty))}, ${seen}`,
        "",
        `The company treasury just paid proposal #${r.proposalId}: ${money(r.amountUsd)} to ${r.counterparty}${memo}, ${tx}.`,
        "Check this payment: confirm the payee is a saved contact (list_allowed) and, when the memo names an invoice, read that invoice (paid_fetch on the invoice reader) and confirm the amount and payee match.",
        "If something doesn't match, mention the agent that drafted it and a person who approves, with the facts. If it's right, report it in one or two lines with the proposal number and the transaction.",
      ].join("\n"),
    };
  }
  if (r.type === "usdc_transfer" && String(r.counterparty).toLowerCase() === treasury.toLowerCase()) {
    return {
      instructions: [
        `Onchain · ${money(r.amountUsd)} USDC came into the treasury from ${short(String(r.actor))}, ${seen}`,
        "",
        `${money(r.amountUsd)} USDC just came into the company treasury from ${r.actor}, ${tx}.`,
        "Find out what it is: a saved contact (list_allowed), one of our own wallets, or funds a person added (for example after a funding request). Check the new treasury balance (get_balances).",
        "If the sender is unknown, mention a person who approves and ask what it is. Otherwise report it in one or two lines with the amount, who sent it and the transaction.",
      ].join("\n"),
    };
  }
  return null;
}

/** Called with every newly stored activity row (QuickNode deliveries and the Arc fallback). */
export async function onNewActivity(rows: ActivityRow[]) {
  for (const r of rows) {
    if (r.type !== "payment_executed" && r.type !== "usdc_transfer") continue;
    const fresh = r.source === "quicknode" || (r.blockTime != null && Date.now() / 1000 - r.blockTime < FRESH_SEC);
    if (!fresh || !r.treasury) continue;
    const key = `${r.txHash}:${r.logIndex}`;
    if (watched.has(key)) continue;
    watched.add(key);
    const ws = db().select().from(schema.workspaces).where(eq(schema.workspaces.treasury, r.treasury.toLowerCase())).get();
    if (!ws) continue;
    try {
      const job = await jobFor(r, ws.treasury);
      if (!job) continue;
      const agent = handlerFor(ws.id, job.proposer);
      if (!agent || !underLimit(ws.id)) continue;
      const { task } = await startTask(agent, ws, { kind: "task", source: "watch", instructions: job.instructions, requestedBy: null, base: publicBase("http://localhost:3000") });
      console.info(`[watch] ${job.instructions.split("\n")[0]} → Grok Bot job ${task.id} for ${agent.name} (${task.status})`);
    } catch (e) {
      console.warn(`[watch] couldn't start a Grok Bot job for ${key}: ${(e as Error).message}`);
    }
  }
}
