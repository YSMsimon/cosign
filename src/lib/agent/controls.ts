/**
 * Enforcement of the agent wallet controls, checked by our server before anything is signed.
 * Budgets and the speed limit use rolling windows over the agent's own spend log (last 24 h,
 * 7 days, 30 days, 1 hour). Without a scope (old script profiles) only the static caps and
 * allowlists apply. Server-only.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { id } from "../server/util";
import { NeedsApproval, PolicyRefusal } from "../x402/buyer";
import { moneyLive, type AgentRules, type Limits } from "./rules";

/** Who is acting: the saved agent, its workspace, the member whose request this is, and the Grok Bot / schedule task if any. */
export type RunScope = { agentId: string; workspaceId: string; memberId: string | null; taskId?: string | null };

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

function paymentsLastHour(agentId: string): number {
  const row = db()
    .select({ n: sql<number>`count(*)` })
    .from(schema.agentSpend)
    .where(and(eq(schema.agentSpend.agentId, agentId), sql`${schema.agentSpend.kind} in ('purchase','draft')`, gte(schema.agentSpend.createdAt, since(HOUR))))
    .get();
  return Number(row?.n ?? 0);
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
  if (max !== null && paymentsLastHour(scope.agentId) >= max) return `speed limit: at most ${max} payments per hour`;
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

export function recordSpend(scope: RunScope | undefined, kind: "purchase" | "draft" | "topup", amountUsd: number, ref: string | null) {
  if (!scope) return;
  db()
    .insert(schema.agentSpend)
    .values({ agentId: scope.agentId, kind, amountUsd: String(amountUsd), ref, memberId: scope.memberId, taskId: scope.taskId ?? null, createdAt: new Date().toISOString() })
    .run();
}

export function recordProposal(scope: RunScope | undefined, treasury: string, proposalId: string) {
  if (!scope) return;
  db()
    .insert(schema.proposalMeta)
    .values({ treasury: treasury.toLowerCase(), proposalId, agentId: scope.agentId, requestedBy: scope.memberId, taskId: scope.taskId ?? null, createdAt: new Date().toISOString() })
    .onConflictDoNothing()
    .run();
}
