/**
 * Enforcement of the agent wallet controls, checked by our server before anything is signed.
 * Budgets and the speed limit use rolling windows over the agent's own spend log (last 24 h,
 * 7 days, 30 days, 1 hour). Without a scope (old script profiles) only the static caps and
 * allowlists apply. Server-only.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { activityBus } from "../activity/store";
import { db, schema } from "../db";
import { id } from "../server/util";
import { NeedsApproval, PolicyRefusal } from "../x402/buyer";
import { moneyLive, type AgentRules, type Limits } from "./rules";

/** Who is acting: the saved agent, its workspace, the member whose request this is, and the Grok Bot / schedule task if any. */
export type RunScope = { agentId: string; workspaceId: string; memberId: string | null; taskId?: string | null; roomId?: string | null };

const HOUR = 3_600_000;
const since = (ms: number) => new Date(Date.now() - ms).toISOString();

function spent(agentId: string, kind: "purchase" | "draft", fromIso: string): number {
  const row = db()
    .select({ total: sql<number>`coalesce(sum(cast(${schema.agentSpend.amountUsd} as real)), 0)` })
    .from(schema.agentSpend)
    .where(and(eq(schema.agentSpend.agentId, agentId), eq(schema.agentSpend.kind, kind), gte(schema.agentSpend.createdAt, fromIso)))
    .get();
  return Number(row?.total ?? 0);
}

/** Purchases and drafts in the last hour, and when the oldest of them happened (it frees the next slot). */
function paymentsLastHour(agentId: string): { n: number; oldest: string | null } {
  const row = db()
    .select({ n: sql<number>`count(*)`, oldest: sql<string | null>`min(${schema.agentSpend.createdAt})` })
    .from(schema.agentSpend)
    .where(and(eq(schema.agentSpend.agentId, agentId), sql`${schema.agentSpend.kind} in ('purchase','draft')`, gte(schema.agentSpend.createdAt, since(HOUR))))
    .get();
  return { n: Number(row?.n ?? 0), oldest: row?.oldest ?? null };
}

const money = (x: number) => `$${Number(x.toFixed(6))}`;

/** Per-payment cap, rolling budgets and the speed limit. Returns a refusal reason or null. */
export function checkLimits(rules: AgentRules, scope: RunScope | undefined, kind: "purchase" | "draft", amount: number): string | null {
  const l: Limits = kind === "purchase" ? rules.controls.purchases : rules.controls.drafts;
  const label = kind === "purchase" ? "purchase" : "draft";
  if (l.perPayment !== null && amount > l.perPayment) return `${label} of ${money(amount)} is over the per-payment cap ${money(l.perPayment)}`;
  if (!scope) return null;
  const windows: [number | null, number, string][] = [
    [l.daily, 24 * HOUR, "daily"],
    [l.weekly, 7 * 24 * HOUR, "weekly"],
    [l.monthly, 30 * 24 * HOUR, "monthly"],
  ];
  for (const [cap, ms, name] of windows) {
    if (cap === null) continue;
    const used = spent(scope.agentId, kind, since(ms));
    if (used + amount > cap + 1e-9) return `${name} ${label} budget ${money(cap)} would be exceeded (${money(used)} used)`;
  }
  const max = rules.controls.maxPaymentsPerHour;
  if (max !== null) {
    const { n, oldest } = paymentsLastHour(scope.agentId);
    if (n >= max) {
      const mins = oldest ? Math.max(1, Math.ceil((Date.parse(oldest) + HOUR - Date.now()) / 60_000)) : 60;
      return `speed limit: at most ${max} payments per hour (a company rule on this agent, not an outside rate limit); the next payment is allowed in about ${mins} minute${mins === 1 ? "" : "s"}`;
    }
  }
  return null;
}

export function moneyRefusal(rules: AgentRules): string | null {
  if (rules.controls.frozen) return "this agent's money abilities are frozen";
  if (!moneyLive(rules.controls)) return "this agent's money abilities have ended (past its end date)";
  return null;
}

/**
 * Called by paidFetch with the real price, right before signing. Throws to stop.
 * Above the ask-a-person line: reuse an approved, unused request for the same URL, or open one.
 */
export function beforePurchase(rules: AgentRules, scope: RunScope | undefined, q: { priceUsd: number; host: string; url: string }) {
  const r = moneyRefusal(rules) ?? checkLimits(rules, scope, "purchase", q.priceUsd);
  if (r) throw new PolicyRefusal(r);
  const ask = rules.controls.askAboveUsd;
  if (ask === null || q.priceUsd <= ask || !scope) return;
  const t = schema.approvalRequests;
  const approved = db()
    .select()
    .from(t)
    .where(and(eq(t.agentId, scope.agentId), eq(t.url, q.url), eq(t.status, "approved"), sql`cast(${t.amountUsd} as real) >= ${q.priceUsd - 1e-9}`))
    .get();
  if (approved) {
    db().update(t).set({ status: "used" }).where(eq(t.id, approved.id)).run();
    return;
  }
  const pending = db().select().from(t).where(and(eq(t.agentId, scope.agentId), eq(t.url, q.url), eq(t.status, "pending"))).get();
  const reqId = pending?.id ?? id("apr");
  if (!pending) {
    db()
      .insert(t)
      .values({
        id: reqId,
        workspaceId: scope.workspaceId,
        agentId: scope.agentId,
        requestedBy: scope.memberId,
        kind: "purchase",
        url: q.url,
        host: q.host,
        amountUsd: String(q.priceUsd),
        status: "pending",
        createdAt: new Date().toISOString(),
      })
      .run();
  }
  throw new NeedsApproval(reqId, `${money(q.priceUsd)} is above this agent's ask-a-person line ${money(ask)}: waiting for a member to OK request ${reqId}. Try again after it is approved.`);
}

/** The payees an agent may draft to, named from the workspace contact book, with the contact's notes. */
export function payeesOf(workspaceId: string | null | undefined, allowed: readonly string[]): { name: string; address: string; notes: string | null }[] {
  const book = new Map(
    workspaceId ? db().select().from(schema.contacts).where(eq(schema.contacts.workspaceId, workspaceId)).all().map((c) => [c.address.toLowerCase(), c]) : [],
  );
  return allowed.map((a) => {
    const c = book.get(a.toLowerCase());
    return { name: c?.name ?? "saved payee (no contact name)", address: a.toLowerCase(), notes: c?.notes ?? null };
  });
}

export function recordSpend(scope: RunScope | undefined, kind: "purchase" | "draft" | "topup", amountUsd: number, ref: string | null) {
  if (!scope) return;
  db()
    .insert(schema.agentSpend)
    .values({ agentId: scope.agentId, kind, amountUsd: String(amountUsd), ref, memberId: scope.memberId, taskId: scope.taskId ?? null, createdAt: new Date().toISOString() })
    .run();
}

/**
 * What the live stream tells pages when an agent drafts a payment (activityBus event "proposal.drafted").
 * taskId is the voice session or Grok Bot / schedule task it came from, so the page in that call can open the cosign card.
 */
export type ProposalDrafted = {
  workspaceId: string;
  treasury: string;
  proposalId: string;
  agentId: string;
  requestedBy: string | null;
  taskId: string | null;
  to: string;
  amountUsd: string;
  memo: string;
  tx: string;
  at: string;
};

/** Remember who drafted a proposal, then tell live subscribers. Called only after the draft is onchain. */
export function recordProposal(scope: RunScope | undefined, treasury: string, proposalId: string, d: { to: string; amountUsd: string; memo: string; tx: string }) {
  if (!scope) return;
  const at = new Date().toISOString();
  const row = { treasury: treasury.toLowerCase(), proposalId, agentId: scope.agentId, requestedBy: scope.memberId, taskId: scope.taskId ?? null, roomId: scope.roomId ?? null, createdAt: at };
  db().insert(schema.proposalMeta).values(row).onConflictDoNothing().run();
  const event: ProposalDrafted = {
    workspaceId: scope.workspaceId,
    treasury: row.treasury,
    proposalId,
    agentId: scope.agentId,
    requestedBy: row.requestedBy,
    taskId: row.taskId,
    to: d.to.toLowerCase(),
    amountUsd: d.amountUsd,
    memo: d.memo,
    tx: d.tx,
    at,
  };
  activityBus.emit("proposal.drafted", event);
}
