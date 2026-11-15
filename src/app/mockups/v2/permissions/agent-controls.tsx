"use client";

import { AgentRank, SpendingChart, SplitDonut } from "./charts";

/* ───────────── B. Control tiles with charts: shadcn charts (on Pesto Chart) + Pesto Rank List, Metric Card, Usage Card ───────────── */
/** Only for an agent with spending to chart (the sample Clerk); the charts read its history. */
export function ControlTiles() {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="col-span-2">
        <SpendingChart />
      </div>
      <SplitDonut />
      <AgentRank />
    </div>
  );
}
