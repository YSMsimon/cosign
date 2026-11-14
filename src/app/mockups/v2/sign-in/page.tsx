"use client";

import { useRouter } from "next/navigation";
import { Check, RefreshCw, Wallet } from "lucide-react";
import { ConnectorList, type ConnectorOption } from "@/components/onchain-ui/connector-list";
import { OrbStack } from "@/components/orb-avatar";
import { UserRow } from "@/components/user-row";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useMockConnect, useWallets, type FoundWallet } from "../wallets";

const ADDRESS = "0x8f2c…41aa";

/** Wallets found in this browser first, then WalletConnect for a phone wallet. */
const options = (found: FoundWallet[]): ConnectorOption[] => [
  ...found.map((w) => ({ id: w.id, name: w.name, icon: w.icon || null, description: "Found in this browser" })),
  { id: "walletconnect", name: "WalletConnect", description: "Scan a QR code with your phone" },
];

/**
 * The first screen (Simon picked option C, 2026-11-14): sign-in only, wallet as the login. The scan is real (EIP-6963:
 * installed wallets announce their name and icon, nothing opens); picking a wallet and signing are a prototype.
 */
export default function SignInPage() {
  const router = useRouter();
  const { wallets, scanning, rescan } = useWallets();
  const c = useMockConnect();
  const sign = () => {
    c.sign();
    setTimeout(() => router.push("/mockups/v2/session"), 900);
  };

  return (
    <main className="flex min-h-screen justify-center bg-background px-8 pt-[14vh] pb-8 text-foreground">
      {/* pinned near the top, not centred, so the heading stays still when the wallet list grows */}
      <div className="flex w-full max-w-sm flex-col items-center gap-5 text-center">
        <OrbStack hues={["blue", "violet", "teal"]} orbClassName="size-9" />
        <div className="flex flex-col gap-1.5">
          <h1 className="text-xl font-semibold">Sign in to Cosign</h1>
          <p className="text-sm text-muted-foreground">Your wallet is your login. Nothing moves without your signature.</p>
        </div>

        <div className="flex w-full flex-col gap-3 text-left">
          {/* the scan (centred, like the heading), then how many wallets it found */}
          <div className={`flex items-center gap-2 text-sm text-muted-foreground ${scanning ? "justify-center" : ""}`} aria-live="polite">
            {scanning ? (
              <>
                <Spinner size="sm" label="Looking for wallets" /> Looking for wallets in this browser…
              </>
            ) : (
              <>
                <Check className="size-4 text-success" /> {wallets.length ? `Found ${wallets.length} wallet${wallets.length === 1 ? "" : "s"} in this browser` : "No wallet extension found"}
                <Button variant="ghost" size="xs" className="ml-auto" onClick={rescan}>
                  <RefreshCw /> Look again
                </Button>
              </>
            )}
          </div>

          {scanning ? (
            /* Pesto Skeleton rows the size of a wallet row, so the list does not jump in when the scan ends */
            <div className="flex flex-col gap-2" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-[52px] rounded-xl" />
              ))}
            </div>
          ) : c.step === "idle" || c.step === "connecting" ? (
            <ConnectorList
              connectors={options(wallets)}
              onSelect={c.connect}
              pendingId={c.step === "connecting" ? c.walletId : null}
              emptyMessage="No wallet found."
              className="gap-2"
              itemClassName="rounded-xl border border-border px-3 py-3"
            />
          ) : c.step === "signing" ? (
            <Item variant="outline" size="sm">
              <ItemMedia variant="icon">
                <Wallet />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Sign in to Nova Labs</ItemTitle>
                <ItemDescription>Your wallet asks you to sign one message. It costs nothing.</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button size="sm" onClick={sign}>
                  Sign message
                </Button>
              </ItemActions>
            </Item>
          ) : (
            <UserRow
              variant="card"
              avatar={
                <Avatar className="size-9">
                  <AvatarFallback>SY</AvatarFallback>
                </Avatar>
              }
              label={`Signed in as ${ADDRESS}`}
              sublabel="Opening Nova Labs…"
              action={<Spinner size="sm" label="Opening Nova Labs" className="text-muted-foreground" />}
            />
          )}
        </div>
      </div>
    </main>
  );
}
