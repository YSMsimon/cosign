/**
 * What agents spent, for the quota tiles and the charts: the same `agent_spend` rows the limits read (purchases from
 * their own wallet, treasury drafts, petty-cash refills). Rolling windows match the limits: "today" is the last 24 h.
 * Server-only.
 */
import { and, gte, inArray } from "drizzle-orm";
import { db, schema } from "../db";

const DAY = 86_400_000;
const HOUR = 3_600_000;
type Totals = { purchases: number; drafts: number; pettyCash: number };
const empty = (): Totals => ({ purchases: 0, drafts: 0, pettyCash: 0 });
const keyOf = (kind: string): keyof Totals => (kind === "purchase" ? "purchases" : kind === "draft" ? "drafts" : "pettyCash");
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const clampDays = (d: number) => Math.min(Math.max(Math.floor(d) || 30, 1), 90);

function rows(agentIds: string[], fromIso: string) {
  if (!agentIds.length) return [];
  const t = schema.agentSpend;
  return db().select().from(t).where(and(inArray(t.agentId, agentIds), gte(t.createdAt, fromIso))).all();
}

/** One series point per UTC day, oldest first, ending today. */
function daySeries(days: number, nowMs: number) {
  return Array.from({ length: days }, (_, i) => ({ date: new Date(nowMs - (days - 1 - i) * DAY).toISOString().slice(0, 10), ...empty() }));
}

/** One agent: the last N days by kind, the last 24 h, and payments in the last hour (the speed limit counts these). */
export function agentSpend(agentId: string, days = 30) {
  const n = clampDays(days);
  const nowMs = Date.now();
  const series = daySeries(n, nowMs);
  const byDate = new Map(series.map((s) => [s.date, s]));
  const last24h = empty();
  let paymentsThisHour = 0;
  for (const r of rows([agentId], new Date(nowMs - n * DAY).toISOString())) {
    const k = keyOf(r.kind);
    const amt = Number(r.amountUsd) || 0;
    const t = Date.parse(r.createdAt);
    const point = byDate.get(r.createdAt.slice(0, 10));
    if (point) point[k] = round(point[k] + amt);
    if (t >= nowMs - DAY) last24h[k] = round(last24h[k] + amt);
    if (t >= nowMs - HOUR && (r.kind === "purchase" || r.kind === "draft")) paymentsThisHour++;
  }
  return { days: series, last24h, paymentsThisHour };
}

/** Every listed agent: totals per agent over N days, per day for all of them, and the last 7 days by kind. */
export function workspaceSpend(agents: { id: string; name: string; hue: string | null }[], days = 30) {
  const n = clampDays(days);
  const nowMs = Date.now();
  const series = daySeries(n, nowMs);
  const byDate = new Map(series.map((s) => [s.date, s]));
  const perAgent = new Map(agents.map((a) => [a.id, { agentId: a.id, name: a.name, hue: a.hue, ...empty() }]));
  const lastWeek = empty();
  for (const r of rows(agents.map((a) => a.id), new Date(nowMs - Math.max(n, 7) * DAY).toISOString())) {
    const k = keyOf(r.kind);
    const amt = Number(r.amountUsd) || 0;
    const t = Date.parse(r.createdAt);
    if (t >= nowMs - 7 * DAY) lastWeek[k] = round(lastWeek[k] + amt);
    if (t < nowMs - n * DAY) continue;
    const point = byDate.get(r.createdAt.slice(0, 10));
    if (point) point[k] = round(point[k] + amt);
    const a = perAgent.get(r.agentId);
    if (a) a[k] = round(a[k] + amt);
  }
  return { days: series, agents: [...perAgent.values()], lastWeek };
}
