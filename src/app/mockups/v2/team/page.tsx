"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Plus } from "lucide-react";
import { Chip } from "@/components/chip";
import { PageHeader } from "@/components/page-header";
import { SectionHeader } from "@/components/section-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableCellStack, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard, TableCardBody, TableCardDescription, TableCardHeader, TableCardTitle } from "@/components/ui/table-card";
import { Tag } from "@/components/ui/tag";
import { NewAgentDialog } from "../agents";
import { AgentOrb, sessions, Shell, sourceTag, team } from "../parts";
import { useAgents } from "../store";

/** Main page 1: the team. Agents up top, every session below. Prototype: agents live in the browser (../store). */
export default function TeamPage() {
  const router = useRouter();
  const { agents, add } = useAgents();
  const [filter, setFilter] = useState<string>("all");
  const open = (id: string) => router.push(`/mockups/v2/session?agent=${id}`);
  const byId = new Map(agents.map((a) => [a.id, a]));
  const rows = sessions.filter((s) => byId.has(s.agent) && (filter === "all" || s.agent === filter));

  return (
    <Shell page="team">
      <div className="mx-auto max-w-5xl px-8 py-8">
        <PageHeader
          title="Team"
          description="Your AI finance team at Nova Labs. Open an agent to talk, or any session to pick it up."
          actions={
            <>
              <Tag variant="warning">2 waiting for your cosign</Tag>
              <NewAgentDialog
                onCreate={(a) => {
                  add(a);
                  open(a.id);
                }}
                trigger={
                  <Button variant="secondary">
                    <Plus /> New agent
                  </Button>
                }
              />
            </>
          }
        />

        <div className="mt-6 grid grid-cols-3 gap-4">
          {agents.map((a) => (
            <Card key={a.id}>
              <CardContent className="flex flex-col gap-3">
                <div className="flex items-start justify-between">
                  <AgentOrb hue={a.hue} className="size-12" />
                  <StatusBadge status={a.online ? "online" : "offline"} pulse={a.online}>
                    {a.online ? "Working" : "Idle"}
                  </StatusBadge>
                </div>
                <div>
                  <div className="text-lg font-semibold">{a.name}</div>
                  <div className="text-sm text-muted-foreground">{a.job}</div>
                </div>
                <div className="text-sm">{a.now}</div>
              </CardContent>
              <CardFooter className="justify-between text-sm text-muted-foreground">
                {team.find((t) => t.id === a.id)?.sessions ?? 0} sessions
                <Button size="sm" variant="secondary" onClick={() => open(a.id)}>
                  Talk
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>

        <div className="mt-10">
          <SectionHeader title="Sessions" description="Every chat, call and task, across all agents." />
          <div className="mt-3 flex gap-2">
            <Chip active={filter === "all"} onClick={() => setFilter("all")}>
              All
            </Chip>
            {agents.map((a) => (
              <Chip key={a.id} active={filter === a.id} onClick={() => setFilter(a.id)}>
                {a.name}
              </Chip>
            ))}
          </div>
          <TableCard className="mt-4">
            <TableCardHeader>
              <TableCardTitle>{rows.length} sessions</TableCardTitle>
              <TableCardDescription className="flex items-center gap-1.5">
                <Lock className="size-3.5" /> Kept for the audit trail. Sessions can&apos;t be deleted.
              </TableCardDescription>
            </TableCardHeader>
            <TableCardBody>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Session</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead className="text-right">Last activity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((s) => {
                    const a = byId.get(s.agent)!;
                    return (
                      <TableRow key={s.title} className="cursor-pointer" onClick={() => open(s.agent)}>
                        <TableCell>
                          <TableCellStack primary={s.title} secondary={s.last} />
                        </TableCell>
                        <TableCell>
                          <span className="flex items-center gap-2">
                            <AgentOrb hue={a.hue} still />
                            {a.name}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Tag variant={sourceTag[s.via]}>{s.via}</Tag>
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">{s.when}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableCardBody>
          </TableCard>
        </div>
      </div>
    </Shell>
  );
}
