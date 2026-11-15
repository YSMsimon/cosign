"use client";

import { AgentRank, SpendingChart, SplitDonut, type RankRow, type SpendDay } from "./charts";

/* ───────────── B. Control tiles with charts: shadcn charts (on Pesto Chart) + Pesto Rank List, Metric Card, Usage Card ───────────── */
/** Only for an agent with spending to chart; the charts read its history (the sample Clerk's on the boards). */
export function ControlTiles({ data }: { data?: { name: string; days: SpendDay[]; budgets: { purchases: number | null; drafts: number | null }; rank: RankRow[] } } = {}) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="col-span-2">
        <SpendingChart {...(data ? { name: data.name, days: data.days, budgets: data.budgets } : {})} />
      </div>
      <SplitDonut {...(data ? { name: data.name, days: data.days } : {})} />
      <AgentRank {...(data ? { rows: data.rank } : {})} />
    </div>
  );
}
