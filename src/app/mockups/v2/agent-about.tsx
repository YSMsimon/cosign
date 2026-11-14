"use client";

import { Landmark, X } from "lucide-react";
import { DescriptionList } from "@/components/description-list";
import { UsageMeter } from "@/components/usage-meter";
import { UserRow } from "@/components/user-row";
import { Button } from "@/components/ui/button";
import type { Agent } from "./agents";
import { AddressSnippet, PETTY_CASH, TREASURY, Usdc, walletOf } from "./money";
import { AgentOrb } from "./parts";

/**
 * About the agent you are talking to, beside the chat (Simon picked option B, 2026-11-14): its own wallet (made when
 * it was created) and its place on the workspace's treasury contract. Opened and closed from the header's info button.
 */
export function AgentAbout({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const w = walletOf(agent.id);
  const can = [w.drafts && "Draft payments", w.pettyCash && "Petty cash"].filter(Boolean).join(" · ") || "No money";
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
          <Usdc amount={w.usdc} />
        </span>
        <AddressSnippet address={w.address} label={`${agent.name}'s wallet address`} />
        <span className="text-xs text-muted-foreground">Made when {agent.name} was created. Pays for APIs and network fees.</span>
      </div>

      <div className="flex flex-col gap-2">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Landmark className="size-4" /> Treasury contract
        </span>
        <AddressSnippet address={TREASURY.address} label="treasury contract address" />
        <DescriptionList
          layout="divided"
          items={[
            { id: "can", term: `${agent.name} can`, details: can },
            { id: "appr", term: "Approvals", details: `${TREASURY.threshold} of ${TREASURY.approvers} people` },
            { id: "bal", term: "Balance", details: <Usdc amount={TREASURY.usdc} /> },
          ]}
        />
        {w.pettyCash && (
          <UsageMeter
            variant="bar"
            size="sm"
            label={`Petty cash this week · $${PETTY_CASH.used.toFixed(2)} of $${PETTY_CASH.perWeek}`}
            value={PETTY_CASH.used}
            max={PETTY_CASH.perWeek}
          />
        )}
      </div>
    </aside>
  );
}
