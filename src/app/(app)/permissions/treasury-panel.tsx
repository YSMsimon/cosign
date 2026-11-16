"use client";

/**
 * The Treasury tab, for real: the contract's balance (with its history from the USDC that moved), its approvers, where
 * money went this week, the onchain activity read from Arc, the ledger of every proposal (open ones are approved or
 * denied in your own wallet, the same as in the chat) and every wallet.
 */
import { useState } from "react";
import { Bot, CircleCheck, CircleX, Coins, Landmark, PiggyBank, RefreshCw, Users } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type Activity, type Proposal as ApiProposal } from "@/lib/client/api";
import { useData } from "@/lib/client/data";
import { shortAddr } from "@/lib/client/wallet";
import { TreasuryTab, type Event, type Proposal, type TreasuryData } from "../../mockups/v2/permissions/treasury";
import { hueOf, useAgentsData } from "../agents-data";
import { initialsOf, personName } from "../app-shell";
import { useCosign } from "../cosign";
import { txUrl } from "../treasury-actions";
import { useTreasuryActions } from "../treasury-actions";

const DAY = 86_400_000;
const usd = (n: number) => `$${n < 1 ? n.toFixed(2) : n % 1 ? n.toFixed(2) : n}`;

function ago(ms: number) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 2 * 86_400) return "Yesterday";
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
const timeOf = (a: Activity) => (a.blockTime ? a.blockTime * 1000 : Date.parse(a.createdAt));

export function TreasuryPanel() {
  const { wsId, ws, address } = useCosign();
  const agentsData = useAgentsData();
  const members = useData(`members:${wsId}`, () => api.members(wsId));
  const contacts = useData(`contacts:${wsId}`, () => api.contacts(wsId));
  const activity = useData(`activity:${wsId}`, () => api.activity(wsId, 200));
  const proposals = useData(`proposals:${wsId}`, () => api.proposals(wsId));
  const spend = useData(`spend:ws:${wsId}`, () => api.spend(wsId));
  const ids = agentsData.views.map((a) => a.id);
  const balances = useData(ids.length ? `agent-balances:${ids.join(",")}` : null, () => Promise.all(ids.map((id) => api.agent(id).then((r) => r.agent))));
  const { cosign, cancel } = useTreasuryActions();
  const [now] = useState(() => Date.now()); // "this week" and the 30 days are from when the tab opened

  if (activity.loading || proposals.loading || members.loading) {
    return (
      <div className="grid grid-cols-3 gap-4" aria-label="Loading the treasury">
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="col-span-3 h-48 rounded-xl" />
      </div>
    );
  }
  const err = activity.error ?? proposals.error ?? members.error;
  if (err) {
    return (
      <Alert
        variant="destructive"
        action={
          <Button size="sm" variant="outline" onClick={() => [activity, proposals, members].forEach((x) => x.error && x.reload())}>
            <RefreshCw /> Try again
          </Button>
        }
      >
        <AlertTitle>Couldn&apos;t load the treasury</AlertTitle>
        <AlertDescription>{err.message}</AlertDescription>
      </Alert>
    );
  }

  // who each address is: agents, people, saved payees, the treasury itself
  const t = ws.treasury.address.toLowerCase();
  const names = new Map<string, string>([[t, "the treasury"]]);
  for (const c of contacts.data?.contacts ?? []) names.set(c.address.toLowerCase(), c.name.split(" (")[0]);
  for (const m of members.data ?? []) names.set(m.address.toLowerCase(), personName(m));
  for (const a of agentsData.views) names.set(a.wallet.toLowerCase(), a.name);
  const nameOf = (a: string | null | undefined) => (a ? (names.get(a.toLowerCase()) ?? shortAddr(a)) : "someone");

  const rows = activity.data?.activity ?? [];
  const balance = Number(ws.treasury.balanceUsd);

  // the balance each day for 30 days, walking back from today's through the USDC that moved in and out
  const flows = rows.filter((r) => r.type === "usdc_transfer" && r.amountUsd);
  const net = (from: number, to: number) =>
    flows.filter((r) => timeOf(r) > from && timeOf(r) <= to).reduce((s, r) => s + (r.counterparty?.toLowerCase() === t ? 1 : r.actor?.toLowerCase() === t ? -1 : 0) * Number(r.amountUsd), 0);
  const spark = Array.from({ length: 30 }, (_, i) => {
    const end = now - (29 - i) * DAY;
    return { date: new Date(end).toISOString().slice(0, 10), balance: Math.round((balance - net(end, now)) * 100) / 100 };
  });
  const weekAgo = balance - net(now - 7 * DAY, now);
  const delta = flows.length && weekAgo > 0 ? Math.round(((balance - weekAgo) / weekAgo) * 1000) / 10 : null;

  const inWeek = (r: Activity) => timeOf(r) > now - 7 * DAY;
  const thisWeek = {
    payments: rows.filter((r) => r.type === "payment_executed" && inWeek(r)).reduce((s, r) => s + Number(r.amountUsd ?? 0), 0),
    pettyCash: rows.filter((r) => r.type === "agent_topped_up" && inWeek(r)).reduce((s, r) => s + Number(r.amountUsd ?? 0), 0),
    apiPurchases: spend.data?.lastWeek.purchases ?? 0,
  };

  const events: Event[] = rows
    .map((r): Event | null => {
      const base = { id: `${r.txHash}-${r.logIndex}`, when: ago(timeOf(r)) };
      const amt = r.amountUsd ? usd(Number(r.amountUsd)) : "";
      switch (r.type) {
        case "proposal_created":
          return { ...base, tone: "info", icon: <Bot />, title: `${nameOf(r.actor)} drafted proposal #${r.proposalId}`, description: `${amt} to ${nameOf(r.counterparty)}` };
        case "proposal_approved":
          return { ...base, tone: "info", icon: <CircleCheck />, title: `${nameOf(r.actor)} approved #${r.proposalId}`, description: "Signed in their own wallet" };
        case "payment_executed":
          return { ...base, tone: "success", icon: <CircleCheck />, title: `Proposal #${r.proposalId} paid`, description: `${amt} to ${nameOf(r.counterparty)}` };
        case "proposal_cancelled":
          return { ...base, tone: "destructive", icon: <CircleX />, title: `Proposal #${r.proposalId} cancelled`, description: `By ${nameOf(r.actor)} · nothing was paid` };
        case "agent_topped_up":
          return { ...base, tone: "warning", icon: <PiggyBank />, title: `${nameOf(r.actor)} refilled its wallet from the treasury`, description: amt };
        case "allowance_set":
          return { ...base, tone: "info", icon: <PiggyBank />, title: `Refill limit set for ${nameOf(r.counterparty)}`, description: `${amt} a week` };
        case "deposited":
          return { ...base, tone: "success", icon: <Coins />, title: `Treasury received ${amt}`, description: `From ${nameOf(r.actor)}` };
        case "usdc_transfer":
          // money in; money out is already its payment, refill or setup above
          return r.counterparty?.toLowerCase() === t ? { ...base, tone: "success", icon: <Coins />, title: `Treasury received ${amt}`, description: `From ${nameOf(r.actor)}` } : null;
        case "approver_added":
        case "approver_removed":
        case "threshold_changed":
        case "approver_change_proposed":
          return { ...base, tone: "info", icon: <Users />, title: r.summary.replace(/0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}/g, (m) => m), description: "" };
        case "treasury_created":
          return { ...base, tone: "info", icon: <Landmark />, title: "Treasury created", description: r.summary };
        default:
          return null;
      }
    })
    .filter((e): e is Event => e !== null)
    .slice(0, 12);

  const ledgerRow = (p: ApiProposal): Proposal => {
    const proposer = (members.data ?? []).find((m) => m.address === p.proposer);
    const by = p.draftedBy?.name ?? (proposer ? personName(proposer) : shortAddr(p.proposer));
    const what =
      p.kind === "payment"
        ? nameOf(p.to)
        : p.kind === "add_approver"
          ? `Add ${nameOf(p.to)} as approver`
          : p.kind === "remove_approver"
            ? `Remove ${nameOf(p.to)} as approver`
            : `Need ${p.newThreshold} approvals`;
    return {
      id: p.id,
      to: what,
      amount: Number(p.amountUsd ?? 0),
      by,
      byHue: p.draftedBy ? hueOf({ id: p.draftedBy.agentId, hue: agentsData.views.find((a) => a.id === p.draftedBy!.agentId)?.hue }) : null,
      byInitials: initialsOf(by, p.proposer),
      approvals: p.approvals,
      threshold: p.threshold,
      canDecide: p.you.canCosign,
      status: p.status === "executed" ? (p.kind === "payment" ? "paid" : "done") : p.status === "cancelled" ? "cancelled" : "open",
      href: p.txHash ? txUrl(p.txHash) : undefined,
    };
  };

  const data: TreasuryData = {
    name: ws.treasury.name || `${ws.workspace.name} treasury`,
    chain: "Arc testnet",
    address: ws.treasury.address,
    balance,
    delta,
    spark,
    threshold: ws.treasury.threshold,
    approvers: ws.treasury.approvers.map((a) => {
      const n = nameOf(a);
      return { name: n, initials: initialsOf(n, a), wallet: a, you: a.toLowerCase() === address };
    }),
    thisWeek,
    events,
    proposals: (proposals.data?.proposals ?? []).map(ledgerRow),
    wallets: agentsData.views.map((a) => {
      const d = balances.data?.find((x) => x.id === a.id);
      const roles = [d?.onchain.isProposer && "Drafts payments"].filter(Boolean) as string[]; // petty cash isn't shown in the app
      return { id: a.id, name: a.name, hue: hueOf(a), address: a.wallet, usdc: d ? Number(d.balances.walletUsdc) : null, roles };
    }),
    decide: async (p, kind, step) => {
      if (kind === "approve") await cosign(p.id, step);
      else await cancel(p.id, step);
    },
  };
  return <TreasuryTab data={data} />;
}
