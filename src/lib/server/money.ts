/**
 * Proposals (read from the contract, annotated with who asked), cosigning and approver changes
 * (prepared for the approver's own wallet), "ask a person" purchase approvals, and the
 * workspace's activity feed. Server-only.
 */
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { formatUnits, isAddress, zeroAddress, type Address } from "viem";
import { approversOf, chain, readProposal } from "../arc";
import { companyTreasuryAbi } from "../contracts/abis";
import { db, schema } from "../db";
import type { ActivityRow, AgentRow } from "../db/schema";
import { can } from "../perm/permissions";
import { memberAccess, requirePerm, type Membership } from "./access";
import { accessOf, agentById, canApprovePurchase } from "./agents";
import { canSeeAgent } from "../perm/permissions";
import { badRequest, conflict, forbidden, notFound, prepare } from "./http";

const KINDS = ["payment", "add_approver", "remove_approver", "set_threshold"] as const;
// settled proposals are read from Arc once (readProposal in ../arc caches them)

export async function listProposals(m: Membership, o: { status?: "open" | "all" } = {}) {
  const t = m.workspace.treasury as Address;
  const [count, threshold, approvers] = await Promise.all([
    chain.readContract({ address: t, abi: companyTreasuryAbi, functionName: "proposalCount" }) as Promise<bigint>,
    chain.readContract({ address: t, abi: companyTreasuryAbi, functionName: "threshold" }) as Promise<number>,
    approversOf(t),
  ]);
  const meIsApprover = approvers.map((a) => a.toLowerCase()).includes(m.address);
  const metas = new Map(db().select().from(schema.proposalMeta).where(eq(schema.proposalMeta.treasury, m.workspace.treasury)).all().map((x) => [x.proposalId, x]));
  const agents = new Map(db().select().from(schema.agents).where(eq(schema.agents.workspaceId, m.workspace.id)).all().map((a) => [a.walletAddress, a]));
  // the transaction that paid or cancelled each proposal, as the QuickNode stream or an Arc read stored it
  const settled = new Map(
    db()
      .select({ id: schema.activity.proposalId, tx: schema.activity.txHash, type: schema.activity.type })
      .from(schema.activity)
      .where(eq(schema.activity.treasury, m.workspace.treasury))
      .all()
      .filter((a) => a.id !== null && (a.type === "payment_executed" || a.type === "proposal_cancelled"))
      .map((a) => [a.id as string, a.tx]),
  );
  const out = [];
  for (let i = Number(count) - 1; i >= 0; i--) {
    const p = await readProposal(t, BigInt(i));
    const open = !p.executed && !p.cancelled;
    if (o.status === "open" && !open) continue;
    const meta = metas.get(String(i));
    const agent = agents.get(p.proposer.toLowerCase());
    const iApproved = meIsApprover && open ? ((await chain.readContract({ address: t, abi: companyTreasuryAbi, functionName: "approvedBy", args: [BigInt(i), m.address as Address] })) as boolean) : false;
    out.push({
      id: i,
      kind: KINDS[p.kind] ?? "unknown",
      to: p.to.toLowerCase(),
      amountUsd: p.kind === 0 ? formatUnits(p.amount, 6) : null,
      newThreshold: p.newThreshold || null,
      memo: p.memo,
      proposer: p.proposer.toLowerCase(),
      draftedBy: agent ? { agentId: agent.id, name: agent.name } : null,
      requestedBy: meta?.requestedBy ?? null,
      taskId: meta?.taskId ?? null,
      createdAt: new Date(Number(p.createdAt) * 1000).toISOString(),
      approvals: p.approvals,
      threshold,
      status: p.executed ? "executed" : p.cancelled ? "cancelled" : "open",
      txHash: open ? null : (settled.get(String(i)) ?? null),
      you: { canCosign: open && meIsApprover && can(m.permissions, "payments.cosign") && !iApproved, approved: iApproved },
    });
  }
  return { threshold, approvers: approvers.map((a) => a.toLowerCase()), youAreApprover: meIsApprover, proposals: out };
}

async function requireOnchainApprover(m: Membership) {
  requirePerm(m, "payments.cosign");
  const approvers = (await approversOf(m.workspace.treasury as Address)).map((a) => a.toLowerCase());
  if (!approvers.includes(m.address)) throw forbidden("your wallet is not an approver on this treasury yet; an approver must propose adding it");
}

/** The approve(id) call for the approver's wallet. */
export async function cosignTx(m: Membership, pid: number) {
  await requireOnchainApprover(m);
  const t = m.workspace.treasury as Address;
  const count = (await chain.readContract({ address: t, abi: companyTreasuryAbi, functionName: "proposalCount" })) as bigint;
  if (pid < 0 || BigInt(pid) >= count) throw notFound("proposal not found");
  const p = await readProposal(t, BigInt(pid));
  if (p.executed || p.cancelled) throw conflict(`proposal #${pid} is ${p.executed ? "already executed" : "cancelled"}`);
  if (await chain.readContract({ address: t, abi: companyTreasuryAbi, functionName: "approvedBy", args: [BigInt(pid), m.address as Address] })) throw conflict("you already approved it");
  const what = p.kind === 0 ? `pay $${formatUnits(p.amount, 6)} to ${p.to}` : `${KINDS[p.kind]} ${p.kind === 3 ? p.newThreshold : p.to}`;
  return prepare(t, companyTreasuryAbi, "approve", [BigInt(pid)], `Cosign #${pid}: ${what}`);
}

export async function cancelTx(m: Membership, pid: number) {
  await requireOnchainApprover(m);
  return prepare(m.workspace.treasury as Address, companyTreasuryAbi, "cancel", [BigInt(pid)], `Cancel #${pid}`);
}

/** proposeApproverChange for the approver's wallet; it executes after the usual number of cosigns. */
export async function approverChangeTx(m: Membership, o: { kind: "add" | "remove" | "threshold"; address?: string; newThreshold?: number; memo?: string }) {
  await requireOnchainApprover(m);
  const kind = { add: 1, remove: 2, threshold: 3 }[o.kind];
  const account = o.kind === "threshold" ? zeroAddress : o.address;
  if (!account || !isAddress(account)) throw badRequest("give the wallet address to add or remove");
  if (o.kind === "threshold" && !o.newThreshold) throw badRequest("give newThreshold");
  const desc = o.kind === "threshold" ? `Change cosigns needed to ${o.newThreshold}` : `${o.kind === "add" ? "Add" : "Remove"} approver ${account}${o.newThreshold ? ` (cosigns needed → ${o.newThreshold})` : ""}`;
  return prepare(m.workspace.treasury as Address, companyTreasuryAbi, "proposeApproverChange", [kind, account, o.newThreshold ?? 0, o.memo ?? desc], desc);
}

// ───────────── "ask a person" approvals ─────────────

export function listApprovals(m: Membership, status = "pending") {
  const ma = memberAccess(m);
  const rows = db()
    .select({ r: schema.approvalRequests, a: schema.agents })
    .from(schema.approvalRequests)
    .innerJoin(schema.agents, eq(schema.approvalRequests.agentId, schema.agents.id))
    .where(and(eq(schema.approvalRequests.workspaceId, m.workspace.id), status === "all" ? sql`1=1` : eq(schema.approvalRequests.status, status)))
    .orderBy(desc(schema.approvalRequests.createdAt))
    .all();
  return rows
    .filter(({ a }) => canSeeAgent(accessOf(a), ma))
    .map(({ r, a }) => ({ ...r, agent: { id: a.id, name: a.name }, you: { canDecide: r.status === "pending" && canApprovePurchase(m, a) } }));
}

export function decideApproval(m: Membership, requestId: string, decision: "approve" | "deny") {
  const r = db().select().from(schema.approvalRequests).where(and(eq(schema.approvalRequests.id, requestId), eq(schema.approvalRequests.workspaceId, m.workspace.id))).get();
  if (!r) throw notFound("request not found");
  if (r.status !== "pending") throw conflict(`request is already ${r.status}`);
  const a = agentById(r.agentId) as AgentRow;
  if (!canApprovePurchase(m, a)) throw forbidden("you need to be able to use this agent and request payments to OK its purchases");
  const status = decision === "approve" ? "approved" : "denied";
  db().update(schema.approvalRequests).set({ status, decidedBy: m.member.id, decidedAt: new Date().toISOString() }).where(eq(schema.approvalRequests.id, requestId)).run();
  return { ...r, status, note: status === "approved" ? "ask the agent to try again: the next purchase of this URL at or below this amount goes through once" : undefined };
}

// ───────────── activity ─────────────

/** Treasury events plus USDC movements of this workspace's agent wallets. */
export function workspaceActivity(m: Membership, limit = 50): ActivityRow[] {
  const wallets = db().select({ w: schema.agents.walletAddress }).from(schema.agents).where(eq(schema.agents.workspaceId, m.workspace.id)).all().map((x) => x.w);
  const t = schema.activity;
  const cond = wallets.length
    ? or(sql`lower(${t.treasury}) = ${m.workspace.treasury}`, inArray(sql`lower(${t.actor})`, wallets), inArray(sql`lower(${t.counterparty})`, wallets))
    : sql`lower(${t.treasury}) = ${m.workspace.treasury}`;
  return db().select().from(t).where(cond).orderBy(desc(t.blockNumber), desc(t.logIndex)).limit(Math.min(Math.max(limit, 1), 500)).all();
}

export function activityMatcher(m: Membership): (row: ActivityRow) => boolean {
  const wallets = new Set(db().select({ w: schema.agents.walletAddress }).from(schema.agents).where(eq(schema.agents.workspaceId, m.workspace.id)).all().map((x) => x.w));
  return (row) => row.treasury?.toLowerCase() === m.workspace.treasury || wallets.has(row.actor?.toLowerCase() ?? "") || wallets.has(row.counterparty?.toLowerCase() ?? "");
}
