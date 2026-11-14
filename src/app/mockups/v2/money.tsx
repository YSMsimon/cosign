"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { getTokenIcon } from "@/lib/onchain/crypto-icons";
import { cn } from "@/lib/utils";

/* onchain-ui's icon adapter: the USDC logo from Trust Wallet's asset list (mainnet USDC address) */
const USDC_LOGO = getTokenIcon({ chainId: 1, address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }) as string;

export const EXPLORER = "https://explorer.testnet.arc.io/address/";
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The workspace's treasury contract on Arc testnet (real address; balance and approvers mock). */
export const TREASURY = { name: "Nova Labs treasury", address: "0xb496FD2D5b29A5b12Ee3d30e7359578fec86e62c", usdc: 48.6, threshold: 1, approvers: 2 };

/** An amount of USDC with the USDC logo, everywhere a wallet amount shows (Simon, 2026-11-14). */
export function Usdc({ amount, size = "sm", className }: { amount: number; size?: "sm" | "md" | "lg"; className?: string }) {
  const logo = size === "lg" ? "size-7" : size === "md" ? "size-5" : "size-4";
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-semibold tabular-nums", size === "lg" && "gap-2 text-2xl", className)}>
      <Avatar className={logo}>
        <AvatarImage src={USDC_LOGO} alt="" />
        <AvatarFallback>$</AvatarFallback>
      </Avatar>
      {amount.toFixed(2)} USDC
    </span>
  );
}

/** A full address to copy or open: shadcn's Snippet pattern (Input Group with a read-only input and buttons). */
export function AddressSnippet({ address, label }: { address: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <InputGroup>
      <InputGroupInput readOnly value={address} aria-label={label} className="font-mono text-xs" />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          aria-label={`Copy ${label}`}
          onClick={() => {
            void navigator.clipboard?.writeText(address);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check /> : <Copy />}
        </InputGroupButton>
        <InputGroupButton size="icon-xs" aria-label={`Open ${label} on the explorer`} asChild>
          <a href={`${EXPLORER}${address}`} target="_blank" rel="noreferrer">
            <ExternalLink />
          </a>
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

/**
 * Each agent's own wallet (mock until wiring: agents.walletAddress and its balance) and what it may do on the
 * treasury. Every agent gets a wallet when it is created; a new agent starts with no money abilities.
 */
const KNOWN: Record<string, { address: string; usdc: number; drafts: boolean; pettyCash: boolean }> = {
  clerk: { address: "0x41c9a7d2e3b8f05c6a1d9e4b7c2f8a3d5e6b8a20", usdc: 0.84, drafts: true, pettyCash: true },
  auditor: { address: "0x9d03f1c8b2a7e6d5c4b3a2f1e0d9c8b7a6f51c4e", usdc: 0.05, drafts: false, pettyCash: false },
  scribe: { address: "0x27be4a9c1d8f3e6b5a2c7d0e9f4b8a1c6d3e70f9", usdc: 0, drafts: false, pettyCash: false },
};
export function walletOf(agentId: string) {
  if (KNOWN[agentId]) return KNOWN[agentId];
  // a stable made-up address for agents created in the prototype
  let h = 0;
  for (const ch of agentId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hex = Array.from({ length: 40 }, (_, i) => ((h >> (i % 28)) ^ (i * 7)) & 15).map((n) => n.toString(16)).join("");
  return { address: `0x${hex}`, usdc: 0, drafts: false, pettyCash: false };
}

/** Teammates' wallets (mock, matching the short forms shown elsewhere); invited people keep the address typed in. */
const PEOPLE: Record<string, string> = {
  simon: "0x8f2c5d1e9b7a3c6f0e4d2b8a1c9e7f5d3b2a41aa",
  priya: "0x51d044bcff24eb6751fdcc80626affe0ad389c3e",
  jordan: "0xa77e136c67657614311f32238751044a0a3c02b1",
  sam: "0x3b19e96e02d8e47f2a7c03be5117b3ed175cd4f0",
};
export const personAddress = (id: string) => PEOPLE[id] ?? walletOf(`person-${id}`).address;

/** The saved payee in the sample (mock). */
export const LENA = { name: "Lena (contractor)", address: "0x7797c2a1e5b9d3f8064a2c7e1b5d9f3a8c6ef1e7" };

/** A short address you can always copy or open on the explorer, for tight places (cards, table rows). */
export function AddressLine({ address, label, className }: { address: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className={cn("inline-flex items-center gap-0.5 font-mono text-xs text-muted-foreground", className)}>
      {short(address)}
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-6"
        aria-label={`Copy ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          void navigator.clipboard?.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
      <Button variant="ghost" size="icon-sm" className="size-6" aria-label={`Open ${label} on the explorer`} asChild>
        <a href={`${EXPLORER}${address}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
          <ExternalLink />
        </a>
      </Button>
    </span>
  );
}

/** Petty cash this week (mock), for agents that have it. */
export const PETTY_CASH = { perWeek: 2, used: 0.6 };
