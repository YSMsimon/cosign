"use client";

import { Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { SectionHeader } from "@/components/section-header";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { personAddress } from "../money";
import { Shell } from "../parts";
import { AgentsTab } from "./agents-tab";
import { PeopleTable } from "./people";
import { TreasuryTab } from "./treasury";

const people = [
  { name: "Simon", sub: "0x8f2c…41aa · you", initials: "SY", role: "Owner", approve: true, request: true },
  { name: "Priya", sub: "0x51d0…9c3e", initials: "PR", role: "Approver", approve: true, request: true },
  { name: "Jordan", sub: "0xa77e…02b1", initials: "JO", role: "Member", approve: false, request: true },
  { name: "Sam", sub: "0x3b19…d4f0", initials: "SA", role: "Viewer", approve: false, request: false },
];

/** Main page 2: who can do what (People), what each agent may spend (Agents), and the vault (Treasury). */
export default function PermissionsPage() {
  return (
    <Shell page="permissions">
      <div className="mx-auto max-w-6xl px-8 py-8">
        <PageHeader
          title="Permissions"
          description="Who can do what at Nova Labs, what each agent may spend, and the treasury that holds the money."
          actions={
            <Button variant="secondary">
              <Plus /> Invite
            </Button>
          }
        />

        <Tabs defaultValue="people" className="mt-6">
          <TabsList>
            <TabsTrigger value="people">People</TabsTrigger>
            <TabsTrigger value="agents">Agents</TabsTrigger>
            <TabsTrigger value="treasury">Treasury</TabsTrigger>
          </TabsList>

          <TabsContent value="people" className="mt-4">
            <SectionHeader title="People" description="Approving happens in each person's own wallet." />
            <PeopleTable
              people={people.map((p) => ({
                id: p.name,
                name: p.name,
                initials: p.initials,
                address: personAddress(p.name.toLowerCase()),
                role: p.role,
                tone: p.role === "Owner" ? "default" : p.role === "Approver" ? "info" : "secondary",
                approve: p.approve,
                request: p.request,
                you: p.sub.endsWith("you"),
              }))}
            />
          </TabsContent>

          <TabsContent value="agents" className="mt-4">
            <AgentsTab />
          </TabsContent>

          <TabsContent value="treasury" className="mt-4">
            <TreasuryTab />
          </TabsContent>
        </Tabs>
      </div>
    </Shell>
  );
}
