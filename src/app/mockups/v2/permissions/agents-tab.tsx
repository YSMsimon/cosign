"use client";

import { useState } from "react";
import { Bot, ChartArea, Coins } from "lucide-react";
import { SectionHeader } from "@/components/section-header";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentOrb } from "../parts";
import { useAgents } from "../store";
import { AbilitiesPanel, ControlTiles, PayeesPanel } from "./agent-controls";
import { LimitsView } from "./limits";
import { hasMoney, setupFor, type AbilityKey } from "./mock";

/**
 * The Agents tab: pick an agent, then its spending (B, charts) and its settings (A). The rule pipeline (C) and money
 * map (D) were removed (Simon, 2026-11-14): explanation, not features, and nothing to wire. An agent with no money
 * ability shows only what it can do; turning one on (prototype, not saved) brings the rest in with the backend's
 * default limits.
 */
export function AgentsTab() {
  const { agents } = useAgents();
  const [picked, setPicked] = useState<string | null>(null);
  const [changed, setChanged] = useState<Record<string, Partial<Record<AbilityKey, boolean>>>>({});

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
  const base = setupFor(agent);
  const a = { ...base, abilities: { ...base.abilities, ...changed[agent.id] } };
  const money = hasMoney(a.abilities);
  const onAbility = (key: AbilityKey, on: boolean) => setChanged((c) => ({ ...c, [agent.id]: { ...c[agent.id], [key]: on } }));

  return (
    <div className="flex flex-col gap-10 pb-16">
      <Tabs value={agent.id} onValueChange={setPicked}>
        <TabsList variant="line">
          {agents.map((x) => (
            <TabsTrigger key={x.id} value={x.id}>
              <AgentOrb hue={x.hue} still className="size-4" />
              {x.name}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {money && (
        <section className="flex flex-col gap-3">
          <SectionHeader title="Spending" description={`What ${a.name} spent and how close it is to each limit.`} />
          {a.history ? (
            <ControlTiles />
          ) : (
            <Empty className="border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ChartArea />
                </EmptyMedia>
                <EmptyTitle>No spending yet</EmptyTitle>
                <EmptyDescription>Charts appear after {a.name}&apos;s first payment.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </section>
      )}

      <section id={`${a.id}-settings`} className="flex scroll-mt-6 flex-col gap-3">
        <SectionHeader title="Settings" description="Checked by our server before anything is signed; petty cash is also enforced by the treasury contract." />
        <div className="grid grid-cols-2 gap-4">
          {money && <LimitsView key={a.id} a={a} />}
          <AbilitiesPanel a={a} onAbility={onAbility} />
          {money ? (
            <PayeesPanel a={a} />
          ) : (
            <Empty className="border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Coins />
                </EmptyMedia>
                <EmptyTitle>No money</EmptyTitle>
                <EmptyDescription>Turn on Pay for APIs, Draft treasury payments or Petty cash to set {a.name}&apos;s limits.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </section>

    </div>
  );
}
