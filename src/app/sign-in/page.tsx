"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, RefreshCw, Wallet } from "lucide-react";
import { ConnectorList, type ConnectorOption } from "@/components/onchain-ui/connector-list";
import { UserRow } from "@/components/user-row";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { clearData } from "@/lib/client/data";
import { connectWallet, shortAddr, signInWith, useWalletProviders, walletErrorText, type FoundWallet } from "@/lib/client/wallet";
import { AgentOrb } from "../mockups/v2/parts";

/** Wallets found in this browser. (WalletConnect needs a project id we don't have, so it isn't offered.) */
const options = (found: FoundWallet[]): ConnectorOption[] => found.map((w) => ({ id: w.id, name: w.name, icon: w.icon || null, description: "Found in this browser" }));

type Step = { step: "idle" } | { step: "connecting"; wallet: FoundWallet } | { step: "signing"; wallet: FoundWallet; address: `0x${string}` } | { step: "connected"; address: string; workspace: string | null };

/**
 * The first screen (Simon picked option C, 2026-11-14): sign-in only, wallet as the login. Installed wallets announce
 * themselves (EIP-6963); picking one asks it for your address, then you sign one message (Sign-In with Ethereum) and
 * the server sets your session.
 */
export default function SignInPage() {
  const router = useRouter();
  const { wallets, scanning, rescan } = useWalletProviders();
  const [s, setS] = useState<Step>({ step: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);

  const connect = async (id: string) => {
    const wallet = wallets.find((w) => w.id === id);
    if (!wallet) return;
    setError(null);
    setS({ step: "connecting", wallet });
    try {
      const address = await connectWallet(wallet);
      setS({ step: "signing", wallet, address });
    } catch (e) {
      setError(walletErrorText(e));
      setS({ step: "idle" });
    }
  };

  const sign = async () => {
    if (s.step !== "signing") return;
    setError(null);
    setSigning(true);
    try {
      const me = await signInWith(s.wallet, s.address);
      clearData();
      setS({ step: "connected", address: me.address, workspace: me.workspaces[0]?.name ?? null });
      router.push("/chat");
    } catch (e) {
      setError(walletErrorText(e));
    } finally {
      setSigning(false);
    }
  };

  return (
    <main className="flex min-h-screen justify-center bg-background px-8 pt-[14vh] pb-8 text-foreground">
      {/* pinned near the top, not centred, so the heading stays still when the wallet list grows */}
      <div className="flex w-full max-w-sm flex-col items-center gap-5 text-center">
        {/* the same live orbs the agents use (moving shapes), overlapped like a stack */}
        <div className="flex -space-x-1.5">
          {(["blue", "violet", "teal"] as const).map((hue) => (
            <AgentOrb key={hue} hue={hue} className="size-9 ring-2 ring-card" />
          ))}
        </div>
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
                <Button variant="ghost" size="xs" className="ml-auto" onClick={rescan} disabled={s.step !== "idle"}>
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
          ) : s.step === "idle" || s.step === "connecting" ? (
            <ConnectorList
              connectors={options(wallets)}
              onSelect={(id) => void connect(id)}
              pendingId={s.step === "connecting" ? s.wallet.id : null}
              emptyMessage="No wallet found. Install a browser wallet (MetaMask, Coinbase Wallet, Rabby…), then look again."
              className="gap-2"
              itemClassName="rounded-xl border border-border px-3 py-3"
            />
          ) : s.step === "signing" ? (
            <Item variant="outline" size="sm">
              <ItemMedia variant="icon">
                <Wallet />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Sign in as {shortAddr(s.address)}</ItemTitle>
                <ItemDescription>Your wallet asks you to sign one message. It costs nothing.</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button size="sm" onClick={() => void sign()} disabled={signing}>
                  {signing ? <Spinner size="sm" label="Waiting for your signature" /> : null}
                  Sign message
                </Button>
              </ItemActions>
            </Item>
          ) : (
            <UserRow
              variant="card"
              avatar={
                <Avatar className="size-9">
                  <AvatarFallback>{s.address.slice(2, 4).toUpperCase()}</AvatarFallback>
                </Avatar>
              }
              label={`Signed in as ${shortAddr(s.address)}`}
              sublabel={s.workspace ? `Opening ${s.workspace}…` : "Opening Cosign…"}
              action={<Spinner size="sm" label="Opening" className="text-muted-foreground" />}
            />
          )}

          {error && (
            <Alert variant="destructive" severityLabel="Not signed in">
              <AlertTitle>Couldn&apos;t sign in</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
      </div>
    </main>
  );
}
