"use client";

/**
 * Permissions, for real: People (members and their roles), Agents (what each may spend, saved on the server, with its
 * refusals shown), Treasury (the contract, its approvers and ledger). Same components and words as
 * /mockups/v2/permissions.
 */
import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { api, type Role } from "@/lib/client/api";
import { invalidate, useData } from "@/lib/client/data";
import { InviteTeammateDialog } from "../../mockups/v2/rooms";
import { AppShell } from "../app-shell";
import { useCosign } from "../cosign";
import { AgentsPanel } from "./agents-panel";
import { PeoplePanel } from "./people-panel";
import { TreasuryPanel } from "./treasury-panel";

/** The role an invite gets: "Member" talks to agents (Agent user), "Approver" can also approve. */
export const inviteRole = (roles: Role[], pick: string) => (pick === "Approver" ? roles.find((r) => r.key === "approver") : roles.find((r) => r.name === "Agent user") ?? roles.find((r) => !r.system));

export function PermissionsView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { wsId, ws, can } = useCosign();
  const [inviting, setInviting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const roles = useData(can("members.manage") ? `roles:${wsId}` : null, () => api.roles(wsId));
  const tab = params.get("tab") ?? (params.get("agent") ? "agents" : "people");
  const go = (next: Record<string, string>) => router.replace(`${pathname}?${new URLSearchParams(next).toString()}`);

  return (
    <AppShell page="permissions">
      <div className="mx-auto max-w-6xl px-8 py-8">
        <PageHeader
          title="Permissions"
          description={`Who can do what at ${ws.workspace.name}, what each agent may spend, and the treasury that holds the money.`}
          actions={
            <Button variant="secondary" onClick={() => setInviting(true)} disabled={!can("members.manage")}>
              <Plus /> Invite
            </Button>
          }
        />

        {notice && (
          <Alert variant="destructive" className="mt-4" action={<Button size="xs" variant="ghost" onClick={() => setNotice(null)}>Dismiss</Button>}>
            <AlertTitle>Couldn&apos;t invite them</AlertTitle>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}

        <Tabs value={tab} onValueChange={(v) => go({ tab: v })} className="mt-6">
          <TabsList>
            <TabsTrigger value="people">People</TabsTrigger>
            <TabsTrigger value="agents">Agents</TabsTrigger>
            <TabsTrigger value="treasury">Treasury</TabsTrigger>
          </TabsList>

          <TabsContent value="people" className="mt-4">
            <PeoplePanel />
          </TabsContent>

          <TabsContent value="agents" className="mt-4">
            <AgentsPanel picked={params.get("agent")} onPick={(id) => go({ tab: "agents", agent: id })} />
          </TabsContent>

          <TabsContent value="treasury" className="mt-4">
            <TreasuryPanel />
          </TabsContent>
        </Tabs>

        <InviteTeammateDialog
          open={inviting}
          onOpenChange={setInviting}
          onInvite={async (t) => {
            setNotice(null);
            try {
              const role = inviteRole(roles.data?.roles ?? [], t.role);
              if (!role) throw new Error("No role to give them; reload and try again.");
              await api.invite(wsId, { address: t.address ?? "", roleId: role.id, title: t.name });
              invalidate(`members:${wsId}`, `team:${wsId}`);
            } catch (e) {
              setNotice((e as Error).message);
            }
          }}
        />
      </div>
    </AppShell>
  );
}
