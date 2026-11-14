"use client";

import { Plus } from "lucide-react";
import { DescriptionList } from "@/components/description-list";
import { PageHeader } from "@/components/page-header";
import { SectionHeader } from "@/components/section-header";
import { UsageMeter } from "@/components/usage-meter";
import { UserRow } from "@/components/user-row";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard, TableCardBody } from "@/components/ui/table-card";
import { Tag } from "@/components/ui/tag";
import { AgentOrb, Shell } from "../parts";
import { useAgents } from "../store";
import { WalletsTable } from "../wallets-table";
import { AddressLine, personAddress } from "../money";

const people = [
  { name: "Simon", sub: "0x8f2c…41aa · you", initials: "SY", role: "Owner", cosign: true, request: true },
  { name: "Priya", sub: "0x51d0…9c3e", initials: "PR", role: "Approver", cosign: true, request: true },
  { name: "Jordan", sub: "0xa77e…02b1", initials: "JO", role: "Member", cosign: false, request: true },
  { name: "Sam", sub: "0x3b19…d4f0", initials: "SA", role: "Viewer", cosign: false, request: false },
];

const agentRules = {
  clerk: {
    who: "Everyone on the team",
    can: ["Pays for APIs", "Drafts payments", "Petty cash", "Own computer"],
    drafts: [2.4, 20],
    buys: [0.03, 0.5],
    payees: "Lena (contractor)",
    ask: "Above $0.05",
  },
  auditor: { who: "Owners and Approvers", can: ["Read only", "Own computer"], drafts: [0, 0], buys: [0, 0], payees: "None", ask: "No money" },
  scribe: { who: "Everyone on the team", can: ["Read only"], drafts: [0, 0], buys: [0, 0], payees: "None", ask: "No money" },
} as const;

/** A new agent starts read-only: no money until an Owner turns it on here. */
const NEW_AGENT_RULES = { who: "Only its creator", can: ["Read only"], drafts: [0, 0], buys: [0, 0], payees: "None", ask: "No money" } as const;
type Rules = (typeof agentRules)[keyof typeof agentRules] | typeof NEW_AGENT_RULES;

/** Main page 2: who can do what, and what each agent may spend. */
export default function PermissionsPage() {
  const { agents } = useAgents();
  return (
    <Shell page="permissions">
      <div className="mx-auto max-w-5xl px-8 py-8">
        <PageHeader
          title="Permissions"
          description="Who can do what at Nova Labs, and what each agent may spend. Loosening a limit needs an Owner."
          actions={
            <Button variant="secondary">
              <Plus /> Invite
            </Button>
          }
        />

        <div className="mt-8">
          <SectionHeader title="People" description="Cosigning happens in each person's own wallet." />
          <TableCard className="mt-3">
            <TableCardBody>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Person</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Can cosign</TableHead>
                    <TableHead>Can ask agents to pay</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {people.map((p) => (
                    <TableRow key={p.name}>
                      <TableCell>
                        <UserRow
                          size="sm"
                          label={p.name}
                          sublabel={
                            <span className="inline-flex items-center gap-1">
                              <AddressLine address={personAddress(p.name.toLowerCase())} label={`${p.name}'s wallet address`} />
                              {p.sub.endsWith("you") && <span className="text-xs text-muted-foreground">· you</span>}
                            </span>
                          }
                          avatar={
                            <Avatar className="size-8">
                              <AvatarFallback>{p.initials}</AvatarFallback>
                            </Avatar>
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <Tag variant={p.role === "Owner" ? "default" : p.role === "Approver" ? "info" : "secondary"}>{p.role}</Tag>
                      </TableCell>
                      <TableCell>
                        <Switch defaultChecked={p.cosign} aria-label={`${p.name} can cosign`} />
                      </TableCell>
                      <TableCell>
                        <Switch defaultChecked={p.request} aria-label={`${p.name} can ask agents to pay`} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableCardBody>
          </TableCard>
        </div>

        <div className="mt-10">
          <SectionHeader title="Agents" description="What each agent may do and spend. The treasury contract enforces petty cash; our server checks the rest before anything is signed." />
          <div className="mt-3 grid grid-cols-3 gap-4">
            {agents.map((a) => {
              const r: Rules = (agentRules as Record<string, Rules>)[a.id] ?? NEW_AGENT_RULES;
              const money = r.drafts[1] > 0;
              return (
                <Card key={a.id}>
                  <CardHeader className="flex flex-row items-center gap-3">
                    <AgentOrb hue={a.hue} still className="size-9" />
                    <div>
                      <div className="font-semibold">{a.name}</div>
                      <div className="text-xs text-muted-foreground">{r.who}</div>
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-1 flex-col gap-4">
                    <div className="flex flex-wrap gap-1.5">
                      {r.can.map((c) => (
                        <Tag key={c} variant="outline">
                          {c}
                        </Tag>
                      ))}
                    </div>
                    {money && (
                      <div className="flex flex-col gap-3">
                        <UsageMeter variant="bar" size="sm" label={`Drafts today · $${r.drafts[0].toFixed(2)} of $${r.drafts[1]}`} value={r.drafts[0]} max={r.drafts[1]} />
                        <UsageMeter variant="bar" size="sm" label={`API purchases · $${r.buys[0].toFixed(2)} of $${r.buys[1].toFixed(2)}`} value={r.buys[0]} max={r.buys[1]} tone="info" />
                      </div>
                    )}
                    <DescriptionList
                      layout="divided"
                      items={[
                        { id: "payees", term: "Payees", details: r.payees },
                        { id: "ask", term: "Ask first", details: r.ask },
                      ]}
                    />
                  </CardContent>
                  <CardFooter className="justify-between text-sm">
                    <span className="text-muted-foreground">Freeze money</span>
                    <Switch aria-label={`Freeze ${a.name}`} disabled={!money} />
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        </div>

        <div className="mt-10 mb-16">
          <SectionHeader title="Wallets and the treasury" description="The treasury contract belongs to the workspace. Every agent has its own wallet, made when the agent is created." />
          <div className="mt-3">
            <WalletsTable />
          </div>
        </div>
      </div>
    </Shell>
  );
}
