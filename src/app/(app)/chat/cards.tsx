"use client";

/**
 * The cards under an agent's tool calls that need a person, drawn with the design board's Approval Row (Pesto Alert):
 * - a purchase over the ask-a-person line: Approve / Deny; approving tells the agent to try again;
 * - a treasury payment it drafted: Approve / Deny in your own wallet (cosign or cancel onchain);
 * - a funding request: Add funds opens Circle's onramp for the treasury (see FundingCard).
 * Each card reads the record's current state, so after a reload it shows what happened.
 */
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/client/api";
import { useData } from "@/lib/client/data";
import { shortAddr } from "@/lib/client/wallet";
import type { Agent } from "../../mockups/v2/agents";
import { EXPLORER } from "../../mockups/v2/money";
import { ApprovalRow } from "../../mockups/v2/parts";
import { useCosign } from "../cosign";
import { STEPS, txUrl, useTreasuryActions } from "../treasury-actions";
import { useChatActions } from "./actions";
import { FundingCard } from "./funding-card";
import type { ToolCall } from "./thread-view";

const usd = (x: unknown) => {
  const n = Number(x);
  return `$${n < 1 ? n.toFixed(2) : n % 1 ? n.toFixed(2) : n}`;
};
const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

/** What an ask-a-person request is for, in words, from the record the limits keep. */
function purchaseWhat(url: string, agent: string) {
  if (url.startsWith("send:")) return { ask: `Let ${agent} send`, what: `to ${shortAddr(url.slice(5))}` };
  if (url.startsWith("swap:")) return { ask: `Let ${agent} swap`, what: `of USDC into ${url.split("->")[1] ?? "a token"}` };
  if (url.startsWith("bridge:")) return { ask: `Let ${agent} bridge`, what: `to ${url.split(":")[1]?.replace(/_/g, " ")}` };
  if (url.startsWith("gateway:")) return { ask: `Let ${agent} move`, what: "into its Gateway balance" };
  if (url.startsWith("earn:")) return { ask: `Let ${agent} put`, what: "in the Earn vault" };
  return { ask: "Pay", what: `for ${hostOf(url)}` };
}

export function ToolCard({ call, agent }: { call: ToolCall; agent: Agent }) {
  const r = call.result as { pending?: boolean; approvalRequestId?: string; proposalId?: string; requestId?: string } | null;
  if (r?.pending && r.approvalRequestId) return <PurchaseCard id={r.approvalRequestId} agent={agent} />;
  if (call.name === "propose_payment" && r?.proposalId !== undefined) return <ProposalCard pid={Number(r.proposalId)} />;
  if (call.name === "request_funds" && r?.requestId) return <FundingCard requestId={r.requestId} />;
  return null;
}

/** A purchase over the agent's ask-a-person line: a member's OK lets it through once, then the agent tries again. */
function PurchaseCard({ id, agent }: { id: string; agent: Agent }) {
  const { wsId } = useCosign();
  const { say } = useChatActions();
  const approvals = useData(`approvals:${wsId}:all`, () => api.approvals(wsId, "all"));
  const a = approvals.data?.approvals.find((x) => x.id === id);
  if (approvals.loading) return <Skeleton className="h-16 rounded-xl" />;
  if (!a) return null;
  const { ask, what } = purchaseWhat(a.url, agent.name);
  const decided = a.status === "pending" ? "open" : a.status === "denied" ? "denied" : "approved";
  return (
    <ApprovalRow
      title={`${ask} ${usd(a.amountUsd)} ${what}?`}
      description={`${a.host.startsWith("wallet-") ? "From its own wallet" : hostOf(a.url)} · over ${agent.name}'s ask-a-person line`}
      decision={decided}
      waiting={a.status === "pending" && !a.you.canDecide ? "Waiting for someone who can use this agent and ask it to pay." : undefined}
      approved={{ title: `OK'd ${usd(a.amountUsd)} ${what}`, note: a.status === "used" ? `${agent.name} went ahead.` : `It can go through once.` }}
      denied={{ title: "Denied", note: "Nothing was paid" }}
      pending={[`Telling ${agent.name} it's OK…`, `${agent.name} is trying again…`]}
      act={async (yes, step) => {
        step(0);
        await api.decide(wsId, id, yes ? "approve" : "deny");
        approvals.reload();
        if (!yes) return;
        step(1);
        say(`I approved request ${id} (${usd(a.amountUsd)} ${what}). Go ahead with it now.`);
        return { note: `${agent.name} is going ahead now. It goes through once.` };
      }}
    />
  );
}

/** A payment the agent drafted on the treasury: approvers cosign it from their own wallets. */
function ProposalCard({ pid }: { pid: number }) {
  const { wsId } = useCosign();
  const proposals = useData(`proposals:${wsId}`, () => api.proposals(wsId));
  const contacts = useData(`contacts:${wsId}`, () => api.contacts(wsId));
  const { cosign, cancel } = useTreasuryActions();
  const p = proposals.data?.proposals.find((x) => x.id === pid);
  if (!p) return <Skeleton className="h-16 rounded-xl" aria-label={`Loading proposal #${pid}`} />;
  const contact = contacts.data?.contacts.find((c) => c.address.toLowerCase() === p.to);
  const name = contact ? contact.name.split(" (")[0] : shortAddr(p.to);
  const decided = p.status === "executed" ? "approved" : p.status === "cancelled" ? "denied" : "open";
  const waiting = p.status === "open" && !p.you.canCosign ? (p.you.approved ? `You approved · ${p.approvals} of ${p.threshold} so far` : `Waiting for an approver · ${p.approvals} of ${p.threshold}`) : undefined;
  return (
    <ApprovalRow
      title={`Approve ${usd(p.amountUsd)} to ${name}?`}
      description={`Proposal #${p.id} · ${p.you.canCosign || p.you.approved ? "you sign in your own wallet" : "an approver signs it in their own wallet"}`}
      address={{ value: p.to, label: `${name}'s wallet address` }}
      decision={decided}
      waiting={waiting}
      approved={{ title: `Paid ${usd(p.amountUsd)} to ${name}`, note: `Proposal #${p.id} · approved`, href: p.txHash ? txUrl(p.txHash) : `${EXPLORER}${p.to}` }}
      denied={{ title: "Denied", note: `Proposal #${p.id} cancelled · nothing was paid` }}
      pending={STEPS.approve}
      denySteps={STEPS.deny}
      act={async (yes, step) => {
        const hash = yes ? await cosign(p.id, step) : await cancel(p.id, step);
        const fresh = await api.proposals(wsId);
        const now = fresh.proposals.find((x) => x.id === p.id);
        proposals.reload();
        if (yes && now?.status === "open") return { title: `You approved #${p.id}`, note: `${now.approvals} of ${now.threshold} approvals · waiting for the rest`, href: txUrl(hash) };
        return { note: yes ? `Proposal #${p.id} · approved by you` : `Proposal #${p.id} cancelled · nothing was paid`, href: txUrl(hash) };
      }}
    />
  );
}
