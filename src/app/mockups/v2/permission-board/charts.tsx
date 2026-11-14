"use client";

import { useMemo, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Label, Pie, PieChart, PolarAngleAxis, RadialBar, RadialBarChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { ChartReferenceLabel } from "@/components/chart-reference-label";
import { RankList, RankListItem } from "@/components/rank-list";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { AgentOrb } from "../parts";
import { clerk, treasury, usd } from "./mock";

/* ───────────── mock series (deterministic), shaped like what agent_spend would give per day ───────────── */
const DAYS = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 9, 16 + i));
  const drafts = [2, 9, 13, 18, 24, 29].includes(i) ? [2.4, 3, 12, 1.5, 2.4, 2.4][[2, 9, 13, 18, 24, 29].indexOf(i)] : 0;
  return {
    date: d.toISOString().slice(0, 10),
    purchases: Math.round(Math.max(0.01, 0.05 + 0.03 * Math.sin(i * 1.3) + 0.02 * Math.sin(i * 0.45 + 1)) * 100) / 100,
    drafts,
    pettyCash: i % 7 === 3 ? 0.6 : i % 7 === 5 ? 0.3 : 0,
  };
});
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const spendConfig = {
  purchases: { label: "API purchases", color: "var(--chart-1)" },
  drafts: { label: "Treasury drafts", color: "var(--chart-2)" },
  pettyCash: { label: "Petty cash", color: "var(--chart-3)" },
} satisfies ChartConfig;
type Series = keyof typeof spendConfig;

/** a money tooltip row: the series label, then the amount */
function moneyRow(config: ChartConfig) {
  return function MoneyRow(value: unknown, name: unknown) {
    return (
      <div className="flex w-full items-center justify-between gap-3">
        <span className="text-muted-foreground">{config[String(name)]?.label ?? String(name)}</span>
        <span className="font-medium tabular-nums">{usd(Number(value))}</span>
      </div>
    );
  };
}

/**
 * Spending per day: shadcn "Bar Chart - Interactive" header (each total switches the series) over the
 * "Area Chart - Gradient" body. One series at a time, because API cents and treasury dollars do not share a scale.
 * The dashed line is that series' daily budget.
 */
export function SpendingChart() {
  const [active, setActive] = useState<Series>("purchases");
  const totals = useMemo(() => Object.fromEntries((Object.keys(spendConfig) as Series[]).map((k) => [k, DAYS.reduce((s, d) => s + d[k], 0)])) as Record<Series, number>, []);
  const budget = active === "purchases" ? clerk.controls.purchases.daily : active === "drafts" ? clerk.controls.drafts.daily : null;
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-row items-stretch border-b p-0!">
        <div className="flex flex-1 flex-col justify-center gap-1 px-6 py-4">
          <CardTitle>Clerk&apos;s spending</CardTitle>
          <CardDescription>Last 30 days. The dashed line is the daily budget.</CardDescription>
        </div>
        <div className="flex">
          {(Object.keys(spendConfig) as Series[]).map((k) => (
            <button
              key={k}
              type="button"
              data-active={active === k}
              className="relative flex flex-col justify-center gap-1 border-l px-6 py-4 text-left data-[active=true]:bg-muted/50"
              onClick={() => setActive(k)}
            >
              <span className="text-xs text-muted-foreground">{spendConfig[k].label}</span>
              <span className="text-2xl leading-none font-bold tabular-nums">{usd(totals[k])}</span>
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="px-2 py-4 sm:px-4">
        <ChartContainer config={spendConfig} className="aspect-auto h-[220px] w-full">
          <AreaChart data={DAYS} margin={{ left: 4, right: 12, top: 12 }}>
            <defs>
              <linearGradient id={`fill-${active}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={`var(--color-${active})`} stopOpacity={0.6} />
                <stop offset="95%" stopColor={`var(--color-${active})`} stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32} tickFormatter={day} />
            <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v) => usd(Number(v))} domain={[0, (max: number) => Math.max(max, budget ?? 0) * 1.1]} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" labelFormatter={(v) => day(String(v))} formatter={moneyRow(spendConfig)} />} />
            {budget !== null && (
              <ReferenceLine y={budget} stroke="var(--muted-foreground)" strokeDasharray="4 4" label={<ChartReferenceLabel variant="pill" label="Daily budget" value={usd(budget)} />} />
            )}
            <Area dataKey={active} type="monotone" fill={`url(#fill-${active})`} stroke={`var(--color-${active})`} strokeWidth={2} />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

const todayConfig = {
  used: { label: "Used today" },
  purchases: { label: "API purchases", color: "var(--chart-1)" },
  drafts: { label: "Treasury drafts", color: "var(--chart-2)" },
} satisfies ChartConfig;

/** Today against the daily budgets: shadcn "Radial Chart" with one ring per budget. */
export function BudgetRadial() {
  const c = clerk.controls;
  const u = clerk.usage;
  const data = [
    { key: "drafts", used: Math.round((u.draftsToday / (c.drafts.daily ?? 1)) * 100), fill: "var(--color-drafts)" },
    { key: "purchases", used: Math.round((u.purchasesToday / (c.purchases.daily ?? 1)) * 100), fill: "var(--color-purchases)" },
  ];
  const top = Math.max(...data.map((d) => d.used));
  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle>Today&apos;s budgets</CardTitle>
        <CardDescription>
          {usd(u.purchasesToday)} of {usd(c.purchases.daily ?? 0)} on APIs · {usd(u.draftsToday)} of {usd(c.drafts.daily ?? 0)} in drafts
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={todayConfig} className="mx-auto aspect-square max-h-[200px]">
          <RadialBarChart data={data} innerRadius={58} outerRadius={92} barSize={12} startAngle={90} endAngle={-270}>
            <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
            <RadialBar dataKey="used" background cornerRadius={8} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel nameKey="key" formatter={(v, _n, item) => `${todayConfig[item.payload.key as "drafts" | "purchases"].label}: ${v}%`} />} />
            <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle">
              <tspan x="50%" dy="-0.2em" className="fill-foreground text-2xl font-bold">
                {top}%
              </tspan>
              <tspan x="50%" dy="1.5em" className="fill-muted-foreground text-xs">
                at most
              </tspan>
            </text>
          </RadialBarChart>
        </ChartContainer>
        <div className="mt-2 flex justify-center gap-4 text-xs text-muted-foreground">
          {data.map((d) => (
            <span key={d.key} className="flex items-center gap-1.5">
              <span className="size-2 rounded-[2px]" style={{ background: `var(--chart-${d.key === "purchases" ? 1 : 2})` }} />
              {todayConfig[d.key as "drafts" | "purchases"].label} {d.used}%
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

const HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((h, i) => ({ hour: `${h}:00`, payments: [2, 4, 1, 6, 12, 3, 5, 2, 0, 1][i] }));
const hourConfig = { payments: { label: "Payments", color: "var(--chart-1)" } } satisfies ChartConfig;

/** Payments per hour today against the speed limit: shadcn "Bar Chart" with a reference line. */
export function HourlyBars() {
  const limit = clerk.controls.maxPaymentsPerHour;
  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle>Payments per hour</CardTitle>
        <CardDescription>Today. Above the line, Clerk is refused.</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={hourConfig} className="aspect-auto h-[200px] w-full">
          <BarChart data={HOURS} margin={{ top: 16, right: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="hour" tickLine={false} axisLine={false} tickMargin={8} interval={1} />
            <YAxis tickLine={false} axisLine={false} width={28} domain={[0, limit]} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
            <ReferenceLine y={limit} stroke="var(--destructive)" strokeDasharray="4 4" label={<ChartReferenceLabel variant="pill" label="Speed limit" value={`${limit}/h`} />} />
            <Bar dataKey="payments" fill="var(--color-payments)" radius={6} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/** Where Clerk's money went this month: shadcn "Pie Chart - Donut with Text". */
export function SplitDonut() {
  const totals = (Object.keys(spendConfig) as Series[]).map((k) => ({ key: k, amount: Math.round(DAYS.reduce((s, d) => s + d[k], 0) * 100) / 100, fill: `var(--color-${k})` }));
  const sum = totals.reduce((s, t) => s + t.amount, 0);
  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle>Where the money went</CardTitle>
        <CardDescription>Clerk, last 30 days</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={spendConfig} className="mx-auto aspect-square max-h-[230px]">
          <PieChart>
            <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel nameKey="key" formatter={moneyRow(spendConfig)} />} />
            <Pie data={totals} dataKey="amount" nameKey="key" innerRadius={52} outerRadius={78} strokeWidth={4}>
              <Label
                content={({ viewBox }) =>
                  viewBox && "cx" in viewBox && "cy" in viewBox ? (
                    <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                      <tspan x={viewBox.cx} y={viewBox.cy} className="fill-foreground text-2xl font-bold">
                        {usd(sum)}
                      </tspan>
                      <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) + 22} className="fill-muted-foreground text-xs">
                        spent
                      </tspan>
                    </text>
                  ) : null
                }
              />
            </Pie>
            <ChartLegend content={<ChartLegendContent nameKey="key" />} />
          </PieChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/** Spending by agent this month: Pesto Rank List, the wash showing each against the top spender. */
export function AgentRank() {
  const sum = (k: Series) => DAYS.reduce((s, d) => s + d[k], 0);
  const rows = [
    {
      name: "Clerk",
      hue: "blue" as const,
      total: sum("drafts") + sum("purchases") + sum("pettyCash"),
      sub: `Drafts ${usd(sum("drafts"))} · APIs ${usd(sum("purchases"))} · petty cash ${usd(sum("pettyCash"))}`,
    },
    { name: "Auditor", hue: "violet" as const, total: 0.36, sub: "APIs $0.36" },
    { name: "Scribe", hue: "teal" as const, total: 0.12, sub: "APIs $0.12" },
  ];
  const max = rows[0].total;
  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle>Spending by agent</CardTitle>
        <CardDescription>Last 30 days, everything each agent spent or drafted</CardDescription>
      </CardHeader>
      <CardContent>
        <RankList>
          {rows.map((r, i) => (
            <RankListItem key={r.name} rank={i + 1} media={<AgentOrb hue={r.hue} still className="size-7" />} label={r.name} sublabel={r.sub} value={usd(r.total)} bar={r.total / max} />
          ))}
        </RankList>
      </CardContent>
    </Card>
  );
}

/* the treasury's balance each day, ending on today's balance (drafts and petty cash leave it) */
const OUT = (d: (typeof DAYS)[number]) => d.drafts + d.pettyCash;
const START = treasury.balanceUsd + DAYS.reduce((s, d) => s + OUT(d), 0);
const BALANCE = DAYS.map((d, i) => ({ date: d.date, balance: Math.round((START - DAYS.slice(0, i + 1).reduce((s, x) => s + OUT(x), 0)) * 100) / 100 }));
const balanceConfig = { balance: { label: "Balance", color: "var(--chart-2)" } } satisfies ChartConfig;

/** The treasury balance over 30 days, small enough for a Metric Card's chart slot (shadcn "Area Chart"). */
export function BalanceSpark() {
  return (
    <ChartContainer config={balanceConfig} className="aspect-auto h-16 w-full">
      <AreaChart data={BALANCE} margin={{ top: 4, bottom: 0, left: 0, right: 0 }}>
        <defs>
          <linearGradient id="fill-balance" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-balance)" stopOpacity={0.5} />
            <stop offset="95%" stopColor="var(--color-balance)" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" labelFormatter={(_, p) => day(String(p?.[0]?.payload?.date ?? ""))} formatter={moneyRow(balanceConfig)} />} />
        <Area dataKey="balance" type="monotone" fill="url(#fill-balance)" stroke="var(--color-balance)" strokeWidth={2} />
      </AreaChart>
    </ChartContainer>
  );
}
