"use client";

/**
 * People: every member, their role, and what it lets them do. The two switches change the role: Can approve → Approver;
 * Can ask agents to pay (without approving) → Agent user; neither → Viewer. All access members and people you may not
 * manage are locked. An Approver approves onchain only once their wallet is added to the treasury (see Treasury).
 */
import { useState } from "react";
import { RefreshCw, Users } from "lucide-react";
import { SectionHeader } from "@/components/section-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type Member, type Role } from "@/lib/client/api";
import { invalidate, useData } from "@/lib/client/data";
import { PeopleTable, type PersonRow } from "../../mockups/v2/permissions/people";
import { initialsOf, personName } from "../app-shell";
import { useCosign } from "../cosign";

function nextRole(roles: Role[], p: Member, perms: string[], which: "approve" | "request", on: boolean) {
  const byKey = (k: string) => roles.find((r) => r.key === k);
  const byName = (n: string) => roles.find((r) => r.name === n);
  if (which === "approve") return on ? byKey("approver") : byName("Agent user");
  if (on) return perms.includes("payments.cosign") ? undefined : byName("Agent user");
  return byName("Viewer");
}

export function PeoplePanel() {
  const { wsId, can, address } = useCosign();
  const members = useData(`members:${wsId}`, () => api.members(wsId));
  const roles = useData(`roles:${wsId}`, () => api.roles(wsId));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const permsOf = (m: Member) => roles.data?.roles.find((r) => r.id === m.role.id)?.permissions ?? [];

  if (members.loading || roles.loading) {
    return (
      <div className="flex flex-col gap-3" aria-label="Loading people">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }
  const err = members.error ?? roles.error;
  if (err) {
    return (
      <Alert variant="destructive" action={<Button size="sm" variant="outline" onClick={() => (members.error ? members.reload() : roles.reload())}><RefreshCw /> Try again</Button>}>
        <AlertTitle>Couldn&apos;t load the people</AlertTitle>
        <AlertDescription>{err.message}</AlertDescription>
      </Alert>
    );
  }
  const list = members.data ?? [];
  const rows: PersonRow[] = list.map((m) => {
    const perms = permsOf(m);
    const name = personName(m);
    return {
      id: m.id,
      name,
      initials: initialsOf(name, m.address),
      address: m.address,
      role: m.role.name,
      tone: m.role.key === "all_access" ? "default" : m.role.key === "approver" ? "info" : "secondary",
      approve: perms.includes("payments.cosign"),
      request: perms.includes("payments.request"),
      you: m.address === address,
      note: !m.joined ? "invited" : m.needsOnchainApprover ? "not on the treasury yet" : undefined,
      locked: !can("members.manage") || m.role.key === "all_access",
    };
  });

  return (
    <>
      <SectionHeader title="People" description="Approving happens in each person's own wallet." />
      {error && (
        <Alert variant="destructive" className="mt-3" action={<Button size="xs" variant="ghost" onClick={() => setError(null)}>Dismiss</Button>}>
          <AlertTitle>The server said no</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {rows.length ? (
        <PeopleTable
          people={rows}
          busy={busy}
          onToggle={async (p, which, on) => {
            const m = list.find((x) => x.id === p.id);
            if (!m) return;
            const role = nextRole(roles.data?.roles ?? [], m, permsOf(m), which, on);
            if (!role || role.id === m.role.id) return;
            setError(null);
            setBusy(p.id);
            try {
              await api.updateMember(wsId, m.id, { roleId: role.id });
              invalidate(`members:${wsId}`, `team:${wsId}`, `ws:${wsId}`);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(null);
            }
          }}
        />
      ) : (
        <Empty className="mt-3 border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Users />
            </EmptyMedia>
            <EmptyTitle>No one yet</EmptyTitle>
            <EmptyDescription>Invite people by their wallet address.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </>
  );
}
