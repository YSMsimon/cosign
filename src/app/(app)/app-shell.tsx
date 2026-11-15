"use client";

import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { invalidate } from "@/lib/client/data";
import { rememberedWallet, shortAddr } from "@/lib/client/wallet";
import { AccountMenu } from "../mockups/v2/account-menu";
import { Shell } from "../mockups/v2/parts";
import { useCosign } from "./cosign";

/** A person's name in the app: the title they were given (CFO, Founder…), else their short address. */
export const personName = (p: { title: string | null; address: string }) => p.title?.trim() || shortAddr(p.address);

/** Two letters for an avatar: from the name's words ("Simon Yang" → SY, "CFO" → CF), else from the address. */
export function initialsOf(name: string, address?: string) {
  if (address && name === shortAddr(address)) return address.slice(2, 4).toUpperCase();
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}

/** The app frame (Pesto Icon Rail) with the signed-in account behind the avatar. */
export function AppShell({ page, children }: { page: "chat" | "permissions"; children: React.ReactNode }) {
  const router = useRouter();
  const { ws, address } = useCosign();
  const name = personName({ title: ws.me.title, address });
  const usdc = ws.me.walletUsdc;
  const account = {
    name,
    initials: initialsOf(name, address),
    address,
    short: shortAddr(address),
    wallet: rememberedWallet()?.name ?? "Wallet",
    usdc: usdc === null ? null : Number(usdc),
    network: "Arc testnet",
  };
  return (
    <Shell
      page={page}
      account={
        <AccountMenu
          account={account}
          onSignOut={async () => {
            await api.logout().catch(() => {});
            invalidate("me");
            router.replace("/sign-in");
          }}
        />
      }
    >
      {children}
    </Shell>
  );
}
