"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, CircleCheck, CircleX, Coins, ExternalLink, Landmark, PiggyBank, Users } from "lucide-react";
import { ActivityFeed, ActivityFeedItem } from "@/components/activity-feed";
import { MetricCard } from "@/components/metric-card";
import { PanelCard, PanelCardAction, PanelCardContent, PanelCardDescription, PanelCardHeader, PanelCardHeading, PanelCardIcon, PanelCardTitle } from "@/components/panel-card";
import { SectionHeader } from "@/components/section-header";
import { SegmentedBar } from "@/components/segmented-bar";
import { UsageMeter } from "@/components/usage-meter";
import { UserRow } from "@/components/user-row";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard, TableCardBody } from "@/components/ui/table-card";
import { Tag } from "@/components/ui/tag";
import { AddressLine, EXPLORER, Usdc } from "../money";
import { AgentOrb } from "../parts";
import { WalletsTable } from "../wallets-table";
import { BalanceSpark } from "./charts";
import { treasury, usd } from "./mock";

type Proposal = { id: number; to: string; amount: number; by: string; approvals: number; status: "open" | "paid" | "done" | "cancelled" };
type Event = { id: string; tone: "info" | "success" | "warning" | "destructive"; icon: React.ReactNode; title: string; description: string; when: string };

/* what happens after a click, in order (prototype: about a second each), like the Approve row in the chat */
const STEPS = {
  approve: ["Connecting to your wallet…", "Waiting for your signature…", "Sending your approval to the treasury on Arc…"],
  deny: ["Connecting to your wallet…", "Waiting for your signature…", "Cancelling the proposal on Arc…"],
};

const FIRST_EVENTS: Event[] = [
  { id: "e3", tone: "info", icon: <Bot />, title: "Clerk drafted proposal #5", description: "$2.40 to Lena", when: "2 min ago" },
  { id: "e2", tone: "success", icon: <CircleCheck />, title: "Proposal #4 paid", description: "$3 · approved by Priya", when: "1 h ago" },
  { id: "e1", tone: "warning", icon: <PiggyBank />, title: "Clerk drew petty cash", description: "$0.60 of $2 this week", when: "Yesterday" },
];

/**
 * The Treasury tab (Simon picked E with F below it, 2026-11-14, without the "Waiting for you" panel): the vault's
 * balance, approvers, where money went and the onchain activity, then the ledger, where open proposals are approved
 * or denied in your own wallet. Prototype: a decision updates the ledger, the activity and the balance.
 */
export function TreasuryTab() {
  const [proposals, setProposals] = useState<Proposal[]>(treasury.proposals);
  const [events, setEvents] = useState<Event[]>(FIRST_EVENTS);
  const [paidNow, setPaidNow] = useState(0);
  const balance = treasury.balanceUsd - paidNow;
  const w = treasury.thisWeek;

  const decided = (p: Proposal, yes: boolean) => {
    setProposals((ps) => ps.map((x) => (x.id === p.id ? { ...x, approvals: yes ? x.approvals + 1 : x.approvals, status: yes ? "paid" : "cancelled" } : x)));
    setEvents((es) => [
      yes
        ? { id: `p${p.id}`, tone: "success", icon: <CircleCheck />, title: `Proposal #${p.id} paid`, description: `${usd(p.amount)} to ${p.to.split(" ")[0]} · approved by you`, when: "Just now" }
        : { id: `p${p.id}`, tone: "destructive", icon: <CircleX />, title: `Proposal #${p.id} cancelled`, description: "Denied by you · nothing was paid", when: "Just now" },
      ...es,
    ]);
    if (yes) setPaidNow((n) => n + p.amount);
  };

  return (
    <div className="flex flex-col gap-10">
      <div className="grid grid-cols-3 gap-4">
        <MetricCard label={`${treasury.name} · ${treasury.chain}`} value={`${usd(balance)} USDC`} icon={<Landmark />} delta={-6.8} deltaLabel="this week" chart={<BalanceSpark />} />
        <PanelCard>
          <PanelCardHeader>
            <PanelCardIcon tone="selected">
              <Users />
            </PanelCardIcon>
            <PanelCardHeading>
              <PanelCardTitle>Approvers</PanelCardTitle>
              <PanelCardDescription>
                {treasury.threshold} of {treasury.approvers.length} must sign
              </PanelCardDescription>
            </PanelCardHeading>
            <PanelCardAction>
              <Button size="xs" variant="outline">
                Change
              </Button>
            </PanelCardAction>
          </PanelCardHeader>
          <PanelCardContent className="flex flex-col gap-2">
            {treasury.approvers.map((a) => (
              <UserRow
                key={a.wallet}
                size="sm"
                avatar={
                  <Avatar className="size-8">
                    <AvatarFallback>{a.initials}</AvatarFallback>
                  </Avatar>
                }
                label={a.name}
                sublabel={<AddressLine address={a.wallet} label={`${a.name}'s wallet address`} />}
                action={a.you ? <Tag size="sm">You</Tag> : undefined}
              />
            ))}
            <UsageMeter variant="pips" size="sm" value={treasury.threshold} max={treasury.approvers.length} label="Signatures needed" />
          </PanelCardContent>
        </PanelCard>
        <PanelCard>
          <PanelCardHeader>
            <PanelCardIcon tone="info">
              <Coins />
            </PanelCardIcon>
            <PanelCardHeading>
              <PanelCardTitle>Where money went this week</PanelCardTitle>
              <PanelCardDescription>{usd(w.apiPurchases + w.pettyCash + w.payments + paidNow)} in total</PanelCardDescription>
            </PanelCardHeading>
          </PanelCardHeader>
          <PanelCardContent>
            <SegmentedBar
              showLegend
              segments={[
                { id: "pay", label: "Treasury payments", value: +(w.payments + paidNow).toFixed(2), tone: "selected" },
                { id: "pc", label: "Petty cash", value: w.pettyCash, tone: "warning" },
                { id: "api", label: "Agents' API purchases", value: w.apiPurchases, tone: "info" },
              ]}
            />
          </PanelCardContent>
        </PanelCard>
        <PanelCard className="col-span-3">
          <PanelCardHeader>
            <PanelCardHeading>
              <PanelCardTitle>Onchain activity</PanelCardTitle>
              <PanelCardDescription>From the QuickNode stream</PanelCardDescription>
            </PanelCardHeading>
          </PanelCardHeader>
          <PanelCardContent>
            <ActivityFeed>
              {events.map((e) => (
                <ActivityFeedItem key={e.id} tone={e.tone} icon={e.icon} title={e.title} description={e.description} timestamp={e.when} />
              ))}
            </ActivityFeed>
          </PanelCardContent>
        </PanelCard>
      </div>

      <div>
        <SectionHeader title="Ledger" description="Every proposal on the treasury contract. Approve or deny an open one here; you sign in your own wallet." />
        <div className="mt-3">
          <Ledger proposals={proposals} onDecided={decided} />
        </div>
      </div>

      <div className="mb-16">
        <SectionHeader title="Wallets" description="The treasury contract belongs to the workspace. Every agent has its own wallet, made when the agent is created." />
        <div className="mt-3">
          <WalletsTable treasuryUsdc={balance} />
        </div>
      </div>
    </div>
  );
}

const TONE = { open: "warning", paid: "success", done: "success", cancelled: "secondary" } as const;
const WORD = { open: "Waiting", paid: "Paid", done: "Done", cancelled: "Cancelled" } as const;

/* ───────────── F. The ledger: every proposal as a row (Pesto Table Card); open ones get Deny and Approve ───────────── */
function Ledger({ proposals, onDecided }: { proposals: Proposal[]; onDecided: (p: Proposal, yes: boolean) => void }) {
  const [busy, setBusy] = useState<{ id: number; kind: "approve" | "deny"; step: number } | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const decide = (p: Proposal, kind: "approve" | "deny") => {
    const steps = STEPS[kind];
    setBusy({ id: p.id, kind, step: 0 });
    steps.forEach((_, i) => i > 0 && timers.current.push(setTimeout(() => setBusy({ id: p.id, kind, step: i }), i * 1300)));
    timers.current.push(
      setTimeout(() => {
        setBusy(null);
        onDecided(p, kind === "approve");
      }, steps.length * 1300),
    );
  };

  return (
    <TableCard>
      <TableCardBody>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>What</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Drafted by</TableHead>
              <TableHead>Approvals</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {proposals.map((p) => {
              const running = busy?.id === p.id ? STEPS[busy.kind][busy.step] : null;
              return (
                <TableRow key={p.id}>
                  <TableCell className="text-muted-foreground tabular-nums">#{p.id}</TableCell>
                  <TableCell className="font-medium">{p.to}</TableCell>
                  <TableCell>{p.amount ? <Usdc amount={p.amount} className="font-normal" /> : "–"}</TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5">
                      {p.by === "Clerk" ? (
                        <AgentOrb hue="blue" still className="size-5" />
                      ) : (
                        <Avatar className="size-5">
                          <AvatarFallback className="text-[0.55rem]">SY</AvatarFallback>
                        </Avatar>
                      )}
                      {p.by}
                    </span>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {p.approvals} of {treasury.threshold}
                  </TableCell>
                  <TableCell>
                    {running ? (
                      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
                        <Spinner size="sm" label={running} />
                        {running}
                      </span>
                    ) : (
                      <Tag variant={TONE[p.status]} size="sm">
                        {WORD[p.status]}
                      </Tag>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {p.status === "open" ? (
                      !running && (
                        <span className="inline-flex gap-2">
                          <Button size="xs" variant="outline" onClick={() => decide(p, "deny")} disabled={busy !== null}>
                            Deny
                          </Button>
                          <Button size="xs" onClick={() => decide(p, "approve")} disabled={busy !== null}>
                            Approve
                          </Button>
                        </span>
                      )
                    ) : (
                      <Button size="xs" variant="ghost" aria-label={`Proposal ${p.id} on the explorer`} asChild>
                        <a href={`${EXPLORER}${treasury.address}`} target="_blank" rel="noreferrer">
                          <ExternalLink />
                        </a>
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableCardBody>
    </TableCard>
  );
}
