"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, ExternalLink, LogOut } from "lucide-react";
import { UserRow } from "@/components/user-row";
import { Avatar, AvatarBadge, AvatarFallback } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tag } from "@/components/ui/tag";
import { Usdc } from "./money";

/* mock account (prototype), shaped like /me plus the wallet's balance */
const me = {
  name: "Simon",
  initials: "SY",
  address: "0x8f2c5d1e9b7a3c6f0e4d2b8a1c9e7f5d3b2a41aa",
  short: "0x8f2c…41aa",
  wallet: "MetaMask",
  usdc: 12.4,
  network: "Arc testnet",
};
const EXPLORER = "https://explorer.testnet.arc.io/address/";

/**
 * The wallet menu behind the rail avatar (Simon picked option A, 2026-11-14; one workspace, so no workspace list):
 * Pesto's Account Menu pattern, a Dropdown Menu behind a User Row. Who you are, your balance and network, copy,
 * explorer, sign out. The dot on the avatar is the network: green when the wallet is on Arc.
 */
export function AccountMenu() {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Your wallet" className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <Avatar className="size-8">
            <AvatarFallback>{me.initials}</AvatarFallback>
            <AvatarBadge className="bg-success" />
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" sideOffset={14} className="w-72">
        <DropdownMenuLabel className="font-normal">
          <UserRow
            size="sm"
            avatar={
              <Avatar className="size-9">
                <AvatarFallback>{me.initials}</AvatarFallback>
              </Avatar>
            }
            label={me.name}
            sublabel={`${me.short} · ${me.wallet}`}
          />
        </DropdownMenuLabel>
        <div className="flex items-center justify-between px-2 pb-2">
          <Usdc amount={me.usdc} size="md" className="text-sm" />
          <Tag size="sm" variant="success">
            {me.network}
          </Tag>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault(); // keep the menu open so the tick is seen
              void navigator.clipboard?.writeText(me.address);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy address"}
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={`${EXPLORER}${me.address}`} target="_blank" rel="noreferrer">
              <ExternalLink /> View on the explorer
            </a>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => router.push("/mockups/v2/sign-in")}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
