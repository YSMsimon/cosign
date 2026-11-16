"use client";

/**
 * The Agents tab, for real: pick an agent, then its spending (charts from what it really spent) and its settings
 * (the design board's accordion), each change saved through PATCH /agents/:id. The server checks every change (only
 * All access may loosen) and its refusal shows on the card. When the treasury contract doesn't match the settings yet
 * (who may draft, the weekly refill, network fees), an approver signs the missing transactions in their own wallet.
 */
import { useState } from "react";
import { Bot, ChartArea, Landmark, RefreshCw } from "lucide-react";
import { SectionHeader } from "@/components/section-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SWAP_TOKENS } from "@/lib/agent/rules";
import { api, type AgentDetail } from "@/lib/client/api";
import { invalidate, useData } from "@/lib/client/data";
import { sendPrepared, shortAddr, walletErrorText } from "@/lib/client/wallet";
import { AgentOrb } from "../../mockups/v2/parts";
import { ControlTiles } from "../../mockups/v2/permissions/agent-controls";
import { AgentSettings, type ListKey } from "../../mockups/v2/permissions/agent-settings";
import type { LimitKey, Limits } from "../../mockups/v2/permissions/limits";
import type { AbilityKey, AgentSetup } from "../../mockups/v2/permissions/mock";
import type { Agent } from "../../mockups/v2/agents";
import { useAgentsData } from "../agents-data";
import { useCosign } from "../cosign";

/** Each limit on the sheet, as the server's controls name it. */
function controlsPatch(next: Limits, keys: LimitKey[], c: AgentDetail["controls"]) {
  const out: Record<string, unknown> = {};
  const purchases = { ...c.purchases };
  const drafts = { ...c.drafts };
  for (const k of keys) {
    const v = next[k];
    if (k === "apiPerPayment") purchases.perPayment = v;
    else if (k === "apiPerDay") purchases.daily = v;
    else if (k === "draftPerPayment") drafts.perPayment = v;
    else if (k === "draftPerDay") drafts.daily = v;
    else if (k === "askAbove") out.askAboveUsd = v > 0 ? v : null; // 0 is "off": asking above $0 would stop every paid call
    else if (k === "perHour") out.maxPaymentsPerHour = v;
    else if (k === "pcPerWeek") out.pettyCashPerWeekUsd = v;
    else if (k === "pcPerRequest") out.topUpMaxUsd = v;
    else if (k === "swapMove") out.maxSlippageBps = Math.round(v * 100);
  }
  if (keys.some((k) => k === "apiPerPayment" || k === "apiPerDay")) out.purchases = purchases;
  if (keys.some((k) => k === "draftPerPayment" || k === "draftPerDay")) out.drafts = drafts;
  return out;
}

export function AgentsPanel({ picked, onPick }: { picked: string | null; onPick: (id: string) => void }) {
  const { wsId, can } = useCosign();
  const data = useAgentsData();
  const agents = data.all;

  if (data.loading) {
    return (
      <div className="flex flex-col gap-4" aria-label="Loading agents">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }
  if (data.error) {
    return (
      <Alert variant="destructive" action={<Button size="sm" variant="outline" onClick={() => data.reload()}><RefreshCw /> Try again</Button>}>
        <AlertTitle>Couldn&apos;t load the agents</AlertTitle>
        <AlertDescription>{data.error.message}</AlertDescription>
      </Alert>
    );
  }
  if (agents.length === 0) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Bot />
          </EmptyMedia>
          <EmptyTitle>No agents yet</EmptyTitle>
          <EmptyDescription>Make an agent in Rooms and agents; its permissions show up here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const agent = agents.find((x) => x.id === picked) ?? agents[0];
  return (
    <div className="flex flex-col gap-10 pb-16">
      <Tabs value={agent.id} onValueChange={onPick}>
        <TabsList variant="line">
          {agents.map((x) => (
            <TabsTrigger key={x.id} value={x.id}>
              <AgentOrb hue={x.hue} className="size-4" />
              {x.name}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <AgentPanel key={agent.id} agent={agent} wsId={wsId} canSeeSpend={can("treasury.view")} />
    </div>
  );
}

function AgentPanel({ agent, wsId, canSeeSpend }: { agent: Agent; wsId: string; canSeeSpend: boolean }) {
  const { ws, address } = useCosign();
  const detail = useData(`agent:${agent.id}`, () => api.agent(agent.id));
  const spend = useData(`spend:agent:${agent.id}`, () => api.agentSpend(agent.id));
  const wsSpend = useData(canSeeSpend ? `spend:ws:${wsId}` : null, () => api.spend(wsId));
  const contacts = useData(canSeeSpend ? `contacts:${wsId}` : null, () => api.contacts(wsId));
  const [signing, setSigning] = useState<string | null>(null);
  const [signError, setSignError] = useState<string | null>(null);
  const activeIds = new Set(useAgentsData().views.map((a) => a.id));

  if (detail.loading) return <Skeleton className="h-96 rounded-xl" aria-label={`Loading ${agent.name}`} />;
  if (detail.error || !detail.data) {
    return (
      <Alert variant="destructive" action={<Button size="sm" variant="outline" onClick={() => detail.reload()}><RefreshCw /> Try again</Button>}>
        <AlertTitle>Couldn&apos;t load {agent.name}</AlertTitle>
        <AlertDescription>{detail.error?.message}</AlertDescription>
      </Alert>
    );
  }
  const d = detail.data.agent;
  const book = new Map((contacts.data?.contacts ?? []).map((c) => [c.address.toLowerCase(), c.name]));
  const s = spend.data;
  const setup: AgentSetup = {
    id: d.id,
    name: d.name,
    hue: agent.hue,
    wallet: d.wallet,
    walletUsdc: Number(d.balances.walletUsdc),
    abilities: { buy: !!d.abilities.buy, draft: !!d.abilities.draft, pettyCash: !!d.abilities.pettyCash },
    controls: { ...d.controls, allowedPayees: d.controls.allowedPayees.map((a) => ({ name: book.get(a.toLowerCase()) ?? shortAddr(a), address: a })) } as unknown as AgentSetup["controls"],
    usage: { purchasesToday: s?.last24h.purchases ?? 0, draftsToday: s?.last24h.drafts ?? 0, paymentsThisHour: s?.paymentsThisHour ?? 0 },
    onchain: { isProposer: d.onchain.isProposer, pettyCashPerWeekUsd: d.onchain.pettyCashPerWeekUsd, pettyCashLeftUsd: Number(d.onchain.pettyCashLeftUsd), inSync: d.onchain.inSync },
    history: !!s?.days.some((x) => x.purchases || x.drafts || x.pettyCash),
  };
  const refresh = () => invalidate(`agent:${agent.id}`, `agents:${wsId}`, `spend:`);
  const patch = async (b: Parameters<typeof api.updateAgent>[1]) => {
    await api.updateAgent(agent.id, b);
    refresh();
  };
  const toSign = d.onchain.toSign;
  const approver = ws.me.onchainApprover;
  const rank = (wsSpend.data?.agents ?? [])
    .filter((r) => activeIds.has(r.agentId))
    .map((r) => ({ name: r.name, hue: agent.id === r.agentId ? agent.hue : (r.hue as AgentSetup["hue"]) ?? "blue", total: r.purchases + r.drafts, sub: `Drafts $${r.drafts.toFixed(2)} · APIs $${r.purchases.toFixed(2)}` }))
    .sort((a, b) => b.total - a.total);

  return (
    <>
      <section className="flex flex-col gap-3">
        <SectionHeader title="Spending" description={`What ${d.name} spent and how close it is to each limit.`} />
        {spend.loading ? (
          <Skeleton className="h-64 rounded-xl" />
        ) : setup.history && s ? (
          <ControlTiles data={{ name: d.name, days: s.days, budgets: { purchases: d.controls.purchases.daily, drafts: d.controls.drafts.daily }, rank }} />
        ) : (
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ChartArea />
              </EmptyMedia>
              <EmptyTitle>No spending yet</EmptyTitle>
              <EmptyDescription>Charts appear after {d.name}&apos;s first payment.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </section>

      <section id={`${d.id}-settings`} className="flex scroll-mt-6 flex-col gap-3">
        <SectionHeader title="Settings" description="Checked by our server before anything is signed; the treasury contract also enforces approvals." />
        {toSign.length > 0 && (
          <Alert
            variant="warning"
            severityLabel="Treasury out of date"
            action={
              approver ? (
                signing ? (
                  <Spinner size="sm" label={signing} className="mx-3 text-muted-foreground" />
                ) : (
                  <Button
                    size="sm"
                    onClick={async () => {
                      setSignError(null);
                      try {
                        for (const [i, tx] of toSign.entries()) {
                          setSigning(`Signing ${i + 1} of ${toSign.length}: ${tx.description}`);
                          await sendPrepared(tx, address);
                        }
                        refresh();
                      } catch (e) {
                        setSignError(walletErrorText(e));
                      } finally {
                        setSigning(null);
                      }
                    }}
                  >
                    <Landmark /> Sign in your wallet
                  </Button>
                )
              ) : undefined
            }
          >
            <AlertTitle>The treasury contract doesn&apos;t match {d.name}&apos;s settings yet</AlertTitle>
            <AlertDescription>
              {toSign.map((t) => (
                <span key={t.description} className="block">
                  {t.description}
                </span>
              ))}
              {!approver && <span className="block">An approver signs these in their own wallet.</span>}
              {signError && <span className="block text-destructive">Didn&apos;t go through: {signError}</span>}
            </AlertDescription>
          </Alert>
        )}
        <div className="grid grid-cols-2 gap-4">
          <AgentSettings
            a={setup}
            onAbility={(key: AbilityKey, on: boolean) => patch({ abilities: { [key]: on } })}
            onSaveLimits={(next, changes) => patch({ controls: controlsPatch(next, changes.map((c) => c.key), d.controls) })}
            onList={(list: ListKey, next: string[]) => patch({ controls: { [list]: next } })}
            addable={{ tokens: [...SWAP_TOKENS], payees: (contacts.data?.contacts ?? []).map((c) => ({ name: c.name, address: c.address })) }}
          />
        </div>
      </section>
    </>
  );
}
