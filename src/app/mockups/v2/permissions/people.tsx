"use client";

import { UserRow } from "@/components/user-row";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard, TableCardBody } from "@/components/ui/table-card";
import { Tag } from "@/components/ui/tag";
import { AddressLine } from "../money";

/** One person on the People tab. `locked`: their switches can't change here (All access, or you may not manage people). */
export type PersonRow = {
  id: string;
  name: string;
  initials: string;
  address: string;
  role: string;
  tone: "default" | "info" | "secondary";
  approve: boolean;
  request: boolean;
  you?: boolean;
  /** shown after the address, e.g. "invited" or "not on the treasury yet" */
  note?: string;
  locked?: boolean;
};

/**
 * Who can do what (Pesto Table Card): each person, their role, and two switches. On the design boards the switches are
 * a sample; in the app they change the person's role (and are locked where that isn't yours to change).
 */
export function PeopleTable({ people, onToggle, busy }: { people: PersonRow[]; onToggle?: (p: PersonRow, which: "approve" | "request", on: boolean) => void; busy?: string | null }) {
  return (
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
              <TableRow key={p.id}>
                <TableCell>
                  <UserRow
                    size="sm"
                    label={p.name}
                    sublabel={
                      <span className="inline-flex items-center gap-1">
                        <AddressLine address={p.address} label={`${p.name}'s wallet address`} />
                        {p.you && <span className="text-xs text-muted-foreground">· you</span>}
                        {p.note && <span className="text-xs text-muted-foreground">· {p.note}</span>}
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
                  <Tag variant={p.tone}>{p.role}</Tag>
                </TableCell>
                <TableCell>
                  {onToggle ? (
                    <Switch checked={p.approve} disabled={p.locked || busy === p.id} onCheckedChange={(v) => onToggle(p, "approve", v)} aria-label={`${p.name} can approve`} />
                  ) : (
                    <Switch defaultChecked={p.approve} aria-label={`${p.name} can approve`} />
                  )}
                </TableCell>
                <TableCell>
                  {onToggle ? (
                    <Switch checked={p.request} disabled={p.locked || busy === p.id} onCheckedChange={(v) => onToggle(p, "request", v)} aria-label={`${p.name} can ask agents to pay`} />
                  ) : (
                    <Switch defaultChecked={p.request} aria-label={`${p.name} can ask agents to pay`} />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableCardBody>
    </TableCard>
  );
}
