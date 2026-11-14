"use client";

import { PageHeader } from "@/components/page-header";
import { SectionHeader } from "@/components/section-header";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Shell } from "../parts";
import { MoneyMap } from "./flow";
import { ControlTiles, RulePipeline, SettingsPanels, VaultLedger, VaultOverview } from "./options";

function Option({ letter, name, source, children }: { letter: string; name: string; source: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold">{letter}.</span>
        <span className="text-sm font-medium">{name}</span>
        <span className="text-xs text-muted-foreground">{source}</span>
      </div>
      {children}
    </section>
  );
}

/** Design board (not in the nav): options for the Permissions page. Mock data shaped like the backend. Pick one per area. */
export default function PermissionBoard() {
  return (
    <Shell page="permissions">
      <div className="mx-auto max-w-6xl px-8 py-8">
        <PageHeader title="Permissions" description="Who can do what, what each agent may spend, and the treasury that holds the money." />
        {/* the page's tabs (Pesto Tabs); the options below fill the Agents and Treasury tabs */}
        <Tabs defaultValue="agents" className="mt-6">
          <TabsList>
            <TabsTrigger value="people">People</TabsTrigger>
            <TabsTrigger value="roles">Roles</TabsTrigger>
            <TabsTrigger value="agents">Agents</TabsTrigger>
            <TabsTrigger value="treasury">Treasury</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="mt-10">
          <SectionHeader title="Agents tab: Clerk's wallet controls" description="Pick one. Each shows the same rules from the backend (abilities, caps, budgets, speed, payees, ask a person, petty cash, freeze)." />
          <div className="mt-6 flex flex-col gap-12">
            <Option letter="A" name="Settings panels" source="Pesto Panel Card, Field, Switch, Input Group, Slider, Select, Usage Meter, Tag">
              <SettingsPanels />
            </Option>
            <Option letter="B" name="Control tiles with charts" source="shadcn charts (Area interactive, Radial, Bar, Pie donut) on Pesto Chart · Pesto Rank List, Metric Card, Usage Card">
              <ControlTiles />
            </Option>
            <Option letter="C" name="Rule pipeline (workflow)" source="Pesto Stepper (vertical), Banner">
              <RulePipeline />
            </Option>
            <Option letter="D" name="Money map (workflow)" source="React Flow with shadcn Card, as shadcn recommends for workflows">
              <MoneyMap />
            </Option>
          </div>
        </div>

        <div className="mt-16 mb-24">
          <SectionHeader title="Treasury tab: the onchain vault" description="Pick one (or E on top, F below it)." />
          <div className="mt-6 flex flex-col gap-12">
            <Option letter="E" name="Vault overview" source="Pesto Metric Card, Panel Card, User Row, Usage Meter, Segmented Bar, Activity Feed + the Approve row">
              <VaultOverview />
            </Option>
            <Option letter="F" name="Vault ledger" source="Pesto Table Card, Tag">
              <VaultLedger />
            </Option>
          </div>
        </div>
      </div>
    </Shell>
  );
}
