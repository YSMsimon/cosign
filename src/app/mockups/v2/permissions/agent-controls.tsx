"use client";

import { ShieldCheck, Sparkles, Store, UserPlus } from "lucide-react";
import { PanelCard, PanelCardContent, PanelCardDescription, PanelCardHeader, PanelCardHeading, PanelCardIcon, PanelCardTitle } from "@/components/panel-card";
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { Tag } from "@/components/ui/tag";
import { AddressLine } from "../money";
import { AgentRank, SpendingChart, SplitDonut } from "./charts";
import { ABILITIES, type AbilityKey, type AgentSetup } from "./mock";

/* ───────────── Settings: what the agent can do, and who it can pay (its limits are in limits.tsx) ───────────── */
/** What the agent can do. The switches are live: turning a money ability on shows its limits below. */
export function AbilitiesPanel({ a, onAbility }: { a: AgentSetup; onAbility: (key: AbilityKey, on: boolean) => void }) {
  return (
    <PanelCard>
      <PanelCardHeader>
        <PanelCardIcon tone="selected">
          <Sparkles />
        </PanelCardIcon>
        <PanelCardHeading>
          <PanelCardTitle>What {a.name} can do</PanelCardTitle>
          <PanelCardDescription>A new agent starts with no money.</PanelCardDescription>
        </PanelCardHeading>
      </PanelCardHeader>
      <PanelCardContent className="flex flex-col gap-1">
        {ABILITIES.map((ab) => (
          <Item key={ab.key} size="sm" className="px-0">
            <ItemContent>
              <ItemTitle>{ab.title}</ItemTitle>
              <ItemDescription>{ab.text}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch checked={a.abilities[ab.key]} onCheckedChange={(on) => onAbility(ab.key, on)} aria-label={`${a.name}: ${ab.title}`} />
            </ItemActions>
          </Item>
        ))}
      </PanelCardContent>
    </PanelCard>
  );
}

/** Who and what the agent may pay: saved payees for treasury drafts, sellers for API purchases. */
export function PayeesPanel({ a }: { a: AgentSetup }) {
  const c = a.controls;
  return (
    <PanelCard>
      <PanelCardHeader>
        <PanelCardIcon tone="success">
          <ShieldCheck />
        </PanelCardIcon>
        <PanelCardHeading>
          <PanelCardTitle>Who and what it can pay</PanelCardTitle>
          <PanelCardDescription>Everything else is blocked.</PanelCardDescription>
        </PanelCardHeading>
      </PanelCardHeader>
      <PanelCardContent className="flex flex-col gap-4">
        {a.abilities.draft && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Payees</span>
            <div className="flex flex-wrap gap-2">
              {c.allowedPayees.map((p) => (
                <Tag key={p.address} variant="secondary" onDismiss={() => {}} dismissLabel={`Remove ${p.name}`}>
                  {p.name} · <AddressLine address={p.address} label={`${p.name}'s address`} />
                </Tag>
              ))}
              <Button size="xs" variant="outline">
                <UserPlus /> Add payee
              </Button>
            </div>
          </div>
        )}
        {a.abilities.buy && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">APIs</span>
            <div className="flex flex-wrap gap-2">
              {c.allowedSellers.map((s) => (
                <Tag key={s} variant="secondary" onDismiss={() => {}} dismissLabel={`Remove ${s}`}>
                  {s}
                </Tag>
              ))}
              <Button size="xs" variant="outline">
                <Store /> Add API
              </Button>
            </div>
          </div>
        )}
        {!a.abilities.buy && !a.abilities.draft && <p className="text-sm text-muted-foreground">Petty cash goes to {a.name}&apos;s own wallet only.</p>}
      </PanelCardContent>
    </PanelCard>
  );
}

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
