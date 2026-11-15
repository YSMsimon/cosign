"use client";

import { Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { SectionHeader } from "@/components/section-header";
import { UserRow } from "@/components/user-row";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard, TableCardBody } from "@/components/ui/table-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tag } from "@/components/ui/tag";
import { AddressLine, personAddress } from "../money";
import { Shell } from "../parts";
import { AgentsTab } from "./agents-tab";
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
            <TableCard className="mt-3">
              <TableCardBody>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Person</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Can approve</TableHead>
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
                          <Switch defaultChecked={p.approve} aria-label={`${p.name} can approve`} />
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
