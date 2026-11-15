"use client";

import { Bot } from "lucide-react";
import { EmptyState, EmptyStateDescription, EmptyStateTitle } from "@/components/ui/empty-state";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/client/api";
import { useData } from "@/lib/client/data";
import { AppShell } from "../app-shell";
import { useCosign } from "../cosign";

/** Rooms and agents (the real page; rooms stay the design board's sample). */
export function ChatView() {
  const { wsId, ws } = useCosign();
  const agents = useData(`agents:${wsId}`, () => api.agents(wsId));
  return (
    <AppShell page="chat">
      <div className="flex h-full">
        <aside className="flex w-72 flex-col overflow-auto border-r border-border px-3 py-4">
          <span className="px-2 text-sm font-semibold">{ws.workspace.name}</span>
          <p className="mt-5 mb-1 px-2 text-xs font-medium text-muted-foreground">Agents</p>
          {agents.loading ? (
            <div className="flex flex-col gap-2">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-14 rounded-xl" />
              ))}
            </div>
          ) : (
            <ul className="flex flex-col gap-1 px-2 text-sm">
              {(agents.data?.agents ?? []).map((a) => (
                <li key={a.id}>{a.name}</li>
              ))}
            </ul>
          )}
        </aside>
        <main className="flex flex-1 items-center justify-center">
          {agents.data && agents.data.agents.length === 0 ? (
            <Empty className="border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Bot />
                </EmptyMedia>
                <EmptyTitle>No agents</EmptyTitle>
                <EmptyDescription>Create one to start.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <EmptyState>
              <EmptyStateTitle>Pick an agent</EmptyStateTitle>
              <EmptyStateDescription>Its conversation opens here.</EmptyStateDescription>
            </EmptyState>
          )}
        </main>
      </div>
    </AppShell>
  );
}
