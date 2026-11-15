"use client";

import { Landmark, X } from "lucide-react";
import { DescriptionList } from "@/components/description-list";
import { UsageMeter } from "@/components/usage-meter";
import { UserRow } from "@/components/user-row";
import { Button } from "@/components/ui/button";
import type { Agent } from "./agents";
import { AddressSnippet, PETTY_CASH, TREASURY, Usdc, walletOf } from "./money";
import { AgentOrb } from "./parts";

/** What the panel shows; the design boards use the sample wallet and treasury, the app passes the real ones. */
export type AboutInfo = {
  wallet: string;
  usdc: number | null;
  can: string;
  treasury: { address: string; threshold: number; approvers: number; usdc: number | null };
  /** petty cash this week, when it has some */
  pettyCash?: { perWeek: number; used: number } | null;
};

function sample(agent: Agent): AboutInfo {
  const w = walletOf(agent.id);
  return {
    wallet: w.address,
    usdc: w.usdc,
    can: [w.drafts && "Draft payments", w.pettyCash && "Petty cash"].filter(Boolean).join(" · ") || "No money",
    treasury: { address: TREASURY.address, threshold: TREASURY.threshold, approvers: TREASURY.approvers, usdc: TREASURY.usdc },
    pettyCash: w.pettyCash ? PETTY_CASH : null,
  };
}

/**
 * About the agent you are talking to, beside the chat (Simon picked option B, 2026-11-14): its own wallet (made when
 * it was created) and its place on the workspace's treasury contract. Opened and closed from the header's info button.
 */
export function AgentAbout({ agent, onClose, info }: { agent: Agent; onClose: () => void; info?: AboutInfo }) {
  const i = info ?? sample(agent);
  const can = i.can;
  return (
    <aside className="flex w-80 shrink-0 flex-col gap-5 overflow-auto border-l border-border p-5" aria-label={`About ${agent.name}`}>
      <UserRow
        avatar={<AgentOrb hue={agent.hue} still className="size-9" />}
        label={agent.name}
        sublabel={agent.job}
        action={
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        }
      />

      <div className="flex flex-col gap-2">
        <span className="flex items-center justify-between text-sm font-medium">
          Wallet
          {i.usdc !== null ? <Usdc amount={i.usdc} /> : <span className="text-xs text-muted-foreground">…</span>}
        </span>
        <AddressSnippet address={i.wallet} label={`${agent.name}'s wallet address`} />
        <span className="text-xs text-muted-foreground">Made when {agent.name} was created. Pays for APIs and network fees.</span>
      </div>

      <div className="flex flex-col gap-2">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Landmark className="size-4" /> Treasury contract
        </span>
        <AddressSnippet address={i.treasury.address} label="treasury contract address" />
        <DescriptionList
          layout="divided"
          items={[
            { id: "can", term: `${agent.name} can`, details: can },
            { id: "appr", term: "Approvals", details: `${i.treasury.threshold} of ${i.treasury.approvers} ${i.treasury.approvers === 1 ? "person" : "people"}` },
            { id: "bal", term: "Balance", details: i.treasury.usdc !== null ? <Usdc amount={i.treasury.usdc} /> : "…" },
          ]}
        />
        {i.pettyCash && (
          <UsageMeter
            variant="bar"
            size="sm"
            label={`Petty cash this week · $${i.pettyCash.used.toFixed(2)} of $${i.pettyCash.perWeek}`}
            value={i.pettyCash.used}
            max={i.pettyCash.perWeek}
          />
        )}
      </div>
    </aside>
  );
}
