/**
 * Agents as saved records. Each agent has exactly one wallet (a Circle developer-controlled EOA),
 * a microVM (started on first use), a shared memory, and one conversation per person.
 *   - Builders create private agents; All access creates team agents.
 *   - Money abilities and anything that loosens limits need All access (agents.money).
 *   - The creator, Approvers and All access can tighten limits or freeze.
 *   - The onchain parts (proposer role, weekly petty cash, gas) are prepared for an approver to sign.
 * Server-only.
 */
import { and, eq } from "drizzle-orm";
import { formatUnits, parseUnits, type Address } from "viem";
import { availableAllowance, chain, createCircleWallet, fmt, nativeBalance, sendUsdc, usdcBalance } from "../arc";
import { companyTreasuryAbi } from "../contracts/abis";
import { db, schema } from "../db";
import type { AgentRow } from "../db/schema";
import { can, canEditAgent, canSeeAgent, canTightenAgent, canUseAgent, type AgentAccess } from "../perm/permissions";
import { DEFAULT_CONTROLS, loosens, mergeAbilities, mergeControls, PRESETS, type Abilities, type AgentRules, type Controls } from "../agent/rules";
import { gatewayBalance } from "../x402/gateway";
import { memberAccess, requirePerm, type Membership } from "./access";
import { badRequest, forbidden, prepare, prepareTransfer, type PreparedTx } from "./http";
import { agentRef, id } from "./util";

const now = () => new Date().toISOString();
const GAS_FLOOR = parseUnits("0.02", 18); // below this an agent can't pay gas for drafts / top-ups
const GAS_TOP_UP = parseUnits("0.05", 18);
const SWEEP_RESERVE = parseUnits("0.003", 18); // left behind to pay for the sweep itself

/** An agent's saved rules; controls added later (e.g. swap tokens) fall back to the defaults. */
export const rulesOf = (a: AgentRow): AgentRules => ({ abilities: JSON.parse(a.abilities) as Abilities, controls: { ...DEFAULT_CONTROLS, ...(JSON.parse(a.controls) as Partial<Controls>) } });
export const accessOf = (a: AgentRow): AgentAccess => ({
  status: a.status,
  visibility: a.visibility as "private" | "team",
  ownerMemberId: a.ownerMemberId,
  allowedRoleIds: a.allowedRoleIds ? (JSON.parse(a.allowedRoleIds) as string[]) : null,
});

export function agentView(a: AgentRow, m: Membership) {
  const acc = accessOf(a);
  const ma = memberAccess(m);
  const r = rulesOf(a);
  return {
    id: a.id,
    name: a.name,
    prompt: a.prompt,
    visibility: a.visibility,
    allowedRoleIds: acc.allowedRoleIds,
    ownerMemberId: a.ownerMemberId,
    status: a.status,
    hue: a.hue,
    wallet: a.walletAddress,
    abilities: r.abilities,
    controls: r.controls,
    you: { canUse: canUseAgent(acc, ma), canEdit: canEditAgent(acc, ma), canTighten: canTightenAgent(acc, ma), canLoosen: can(m.permissions, "agents.money") },
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function roleIdsIn(workspaceId: string, ids: string[] | null | undefined): string[] | null {
  if (!ids) return null;
  const known = new Set(db().select().from(schema.roles).where(eq(schema.roles.workspaceId, workspaceId)).all().map((r) => r.id));
  for (const r of ids) if (!known.has(r)) throw badRequest(`unknown role ${r}`);
  return [...new Set(ids)];
}

export async function createAgent(
  m: Membership,
  o: { name: string; prompt: string; visibility: "private" | "team"; preset?: keyof typeof PRESETS; allowedRoleIds?: string[] | null; controls?: unknown; hue?: string | null },
) {
  if (o.visibility === "team") requirePerm(m, "agents.manage");
  else if (!can(m.permissions, "agents.build") && !can(m.permissions, "agents.manage")) throw forbidden(`your role (${m.role.name}) can't build agents`);
  const preset = o.preset ?? "readonly";
  const abilities = PRESETS[preset];
  if ((abilities.buy || abilities.draft || abilities.pettyCash) && !can(m.permissions, "agents.money")) {
    throw forbidden("only All access can give an agent money abilities; create it read-only and ask them");
  }
  const controls = mergeControls(DEFAULT_CONTROLS, o.controls ?? {});
  const ref = agentRef();
  const w = await createCircleWallet(ref, `${o.name} ${m.workspace.name}`.slice(0, 60));
  const row: AgentRow = {
    id: id("ag"),
    workspaceId: m.workspace.id,
    name: o.name,
    prompt: o.prompt,
    visibility: o.visibility,
    allowedRoleIds: o.visibility === "team" && o.allowedRoleIds ? JSON.stringify(roleIdsIn(m.workspace.id, o.allowedRoleIds)) : null,
    ownerMemberId: m.member.id,
    abilities: JSON.stringify(abilities),
    controls: JSON.stringify(controls),
    ref,
    walletId: w.id,
    walletAddress: w.address.toLowerCase(),
    status: "active",
    hue: o.hue ?? null,
    createdAt: now(),
    updatedAt: now(),
  };
  db().insert(schema.agents).values(row).run();
  return row;
}

export function listAgents(m: Membership) {
  const ma = memberAccess(m);
  return db()
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.workspaceId, m.workspace.id))
    .all()
    .filter((a) => canSeeAgent(accessOf(a), ma))
    .map((a) => agentView(a, m));
}

export function requireSee(m: Membership, a: AgentRow) {
  if (!canSeeAgent(accessOf(a), memberAccess(m))) throw forbidden("this is someone else's private agent");
}

export async function agentDetail(m: Membership, a: AgentRow) {
  requireSee(m, a);
  const addr = a.walletAddress as Address;
  const [usdc, gas, gateway] = await Promise.all([usdcBalance(addr), nativeBalance(addr), gatewayBalance(addr).catch(() => null)]);
  return { ...agentView(a, m), balances: { walletUsdc: fmt(usdc), gasUsdc: formatUnits(gas, 18), gatewayUsdc: gateway }, onchain: await onchainStatus(m, a) };
}

/** Change an agent. Name/prompt/visibility: its creator or agents.manage. Abilities/controls: loosening needs All access, tightening the creator / Approver / All access. */
export function updateAgent(
  m: Membership,
  a: AgentRow,
  patch: { name?: string; prompt?: string; visibility?: "private" | "team"; allowedRoleIds?: string[] | null; abilities?: unknown; controls?: unknown },
) {
  requireSee(m, a);
  if (a.status !== "active") throw badRequest("this agent is retired");
  const acc = accessOf(a);
  const ma = memberAccess(m);
  const set: Partial<AgentRow> = {};
  if (patch.name !== undefined || patch.prompt !== undefined || patch.visibility !== undefined || patch.allowedRoleIds !== undefined) {
    if (!canEditAgent(acc, ma)) throw forbidden("only the agent's creator or All access can edit it");
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.prompt !== undefined) set.prompt = patch.prompt;
    if (patch.visibility !== undefined && patch.visibility !== a.visibility) {
      if (patch.visibility === "team") requirePerm(m, "agents.manage");
      set.visibility = patch.visibility;
    }
    if (patch.allowedRoleIds !== undefined) set.allowedRoleIds = patch.allowedRoleIds ? JSON.stringify(roleIdsIn(a.workspaceId, patch.allowedRoleIds)) : null;
  }
  if (patch.abilities !== undefined || patch.controls !== undefined) {
    const before = rulesOf(a);
    const after: AgentRules = { abilities: mergeAbilities(before.abilities, patch.abilities), controls: mergeControls(before.controls, patch.controls) };
    const looser = loosens(before, after);
    if (looser.length && !can(m.permissions, "agents.money")) throw forbidden(`only All access can loosen an agent (${looser.join(", ")})`);
    if (!looser.length && !canTightenAgent(acc, ma)) throw forbidden("only the agent's creator, an Approver or All access can change its limits");
    set.abilities = JSON.stringify(after.abilities);
    set.controls = JSON.stringify(after.controls);
  }
  set.updatedAt = now();
  db().update(schema.agents).set(set).where(eq(schema.agents.id, a.id)).run();
  return agentView(db().select().from(schema.agents).where(eq(schema.agents.id, a.id)).get()!, m);
}

/** Move what's in the agent's wallet back to the treasury (the only destination). */
export async function sweepAgent(m: Membership, a: AgentRow) {
  if (!can(m.permissions, "agents.sweep") && !can(m.permissions, "agents.money")) throw forbidden("only Approvers and All access can sweep an agent's wallet");
  const bal = await nativeBalance(a.walletAddress as Address);
  if (bal <= SWEEP_RESERVE) return { swept: "0", note: "nothing to sweep" };
  const amount = Number(formatUnits(bal - SWEEP_RESERVE, 18)).toFixed(6).replace(/\.?0+$/, "");
  if (Number(amount) <= 0) return { swept: "0", note: "nothing to sweep" };
  const hash = await sendUsdc(a.ref, m.workspace.treasury as Address, amount);
  return { swept: amount, tx: hash, to: m.workspace.treasury, note: "Gateway (nanopayment) balance, if any, stays in Gateway" };
}

/** Retire: freeze, sweep, mark retired; returns the onchain clean-up for an approver to sign. */
export async function retireAgent(m: Membership, a: AgentRow) {
  requirePerm(m, "agents.manage");
  const c = { ...rulesOf(a).controls, frozen: true };
  db().update(schema.agents).set({ controls: JSON.stringify(c), status: "retired", updatedAt: now() }).where(eq(schema.agents.id, a.id)).run();
  const sweep = await sweepAgent(m, a).catch((e) => ({ swept: "0", note: `sweep failed: ${(e as Error).message}` }));
  const status = await readOnchain(m.workspace.treasury, a.walletAddress);
  const txs: PreparedTx[] = [];
  if (status.isProposer) txs.push(prepare(m.workspace.treasury as Address, companyTreasuryAbi, "setProposer", [a.walletAddress, false], `Remove ${a.name}'s right to draft`));
  if (status.allowancePerWeek > 0) txs.push(prepare(m.workspace.treasury as Address, companyTreasuryAbi, "setAgentAllowance", [a.walletAddress, 0n, 0n], `End ${a.name}'s petty cash`));
  return { retired: a.id, sweep, onchainCleanup: txs };
}

async function readOnchain(treasury: string, agent: string) {
  const [isProposer, allowance] = await Promise.all([
    chain.readContract({ address: treasury as Address, abi: companyTreasuryAbi, functionName: "isProposer", args: [agent as Address] }) as Promise<boolean>,
    chain.readContract({ address: treasury as Address, abi: companyTreasuryAbi, functionName: "agentAllowance", args: [agent as Address] }) as Promise<readonly [bigint, bigint, bigint, bigint]>,
  ]);
  return { isProposer, allowancePerWeek: Number(formatUnits(allowance[0], 6)), allowancePeriodSec: Number(allowance[1]) };
}

/** Where the contract stands for this agent, and the transactions an approver should sign to match its settings. */
export async function onchainStatus(m: Membership, a: AgentRow) {
  const r = rulesOf(a);
  const t = m.workspace.treasury as Address;
  const s = await readOnchain(t, a.walletAddress);
  const gas = await nativeBalance(a.walletAddress as Address);
  const txs: PreparedTx[] = [];
  const active = a.status === "active";
  if (active && r.abilities.draft && !s.isProposer) txs.push(prepare(t, companyTreasuryAbi, "setProposer", [a.walletAddress, true], `Let ${a.name} draft payments (you still cosign each one)`));
  if ((!active || !r.abilities.draft) && s.isProposer) txs.push(prepare(t, companyTreasuryAbi, "setProposer", [a.walletAddress, false], `Remove ${a.name}'s right to draft`));
  const want = active && r.abilities.pettyCash ? (r.controls.pettyCashPerWeekUsd ?? 0) : 0;
  if (want !== s.allowancePerWeek) {
    txs.push(
      prepare(t, companyTreasuryAbi, "setAgentAllowance", [a.walletAddress, parseUnits(String(want), 6), want ? 7n * 86400n : 0n], want ? `Let ${a.name} refill its wallet with up to $${want} a week` : `Stop ${a.name}'s weekly refill`),
    );
  }
  const needsGas = active && (r.abilities.draft || r.abilities.pettyCash || r.abilities.buy);
  if (needsGas && gas < GAS_FLOOR) txs.push(prepareTransfer(a.walletAddress as Address, GAS_TOP_UP, `Send ${a.name} 0.05 USDC for network fees`));
  return {
    isProposer: s.isProposer,
    pettyCashPerWeekUsd: s.allowancePerWeek,
    pettyCashLeftUsd: s.allowancePerWeek ? await availableAllowance(t, a.walletAddress as Address) : "0",
    gasUsdc: formatUnits(gas, 18),
    inSync: txs.length === 0,
    toSign: txs, // for an approver's own wallet
  };
}

/** Members of the workspace who can use this agent and request payments (they may OK its purchases). */
export function canApprovePurchase(m: Membership, a: AgentRow) {
  return can(m.permissions, "payments.request") && canUseAgent(accessOf(a), memberAccess(m));
}

export function agentById(agentId: string) {
  return db().select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
}
export function agentsOfWorkspace(workspaceId: string) {
  return db().select().from(schema.agents).where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.status, "active"))).all();
}
