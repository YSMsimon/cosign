"use client";

import { useCallback, useEffect, useState } from "react";

/** A browser wallet that announced itself (EIP-6963): its own name and icon. */
export type FoundWallet = { id: string; name: string; icon: string; rdns: string };

type Announce = CustomEvent<{ info: { uuid: string; name: string; icon: string; rdns: string } }>;

/**
 * Real detection, nothing mocked: every installed wallet extension answers an EIP-6963 request with its name and
 * icon. Reading this never opens a wallet. A wallet that only sets window.ethereum shows up as "Browser wallet".
 * Connecting is still mocked on the design boards.
 */
export function useWallets(scanMs = 1400) {
  const [wallets, setWallets] = useState<FoundWallet[]>([]);
  const [scanning, setScanning] = useState(true);
  const [round, setRound] = useState(0);

  useEffect(() => {
    const found = new Map<string, FoundWallet>();
    const onAnnounce = (e: Event) => {
      const { info } = (e as Announce).detail;
      if (found.has(info.rdns)) return;
      found.set(info.rdns, { id: info.uuid, name: info.name, icon: info.icon, rdns: info.rdns });
      setWallets([...found.values()]);
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const done = setTimeout(() => {
      const legacy = (window as unknown as { ethereum?: unknown }).ethereum;
      if (!found.size && legacy) {
        found.set("legacy", { id: "legacy", name: "Browser wallet", icon: "", rdns: "legacy" });
        setWallets([...found.values()]);
      }
      setScanning(false);
    }, scanMs);
    return () => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      clearTimeout(done);
    };
  }, [round, scanMs]);

  const rescan = useCallback(() => {
    setWallets([]);
    setScanning(true);
    setRound((r) => r + 1);
  }, []);

  return { wallets, scanning, rescan };
}

/** Prototype of connect + sign in: pick a wallet, then sign one message. No wallet is called. */
export function useMockConnect() {
  const [state, setState] = useState<{ step: "idle" | "connecting" | "signing" | "connected"; walletId?: string }>({ step: "idle" });
  const connect = (walletId: string) => {
    setState({ step: "connecting", walletId });
    setTimeout(() => setState({ step: "signing", walletId }), 1500);
  };
  const sign = () => {
    setState((s) => ({ ...s, step: "connected" }));
  };
  const reset = () => setState({ step: "idle" });
  return { ...state, connect, sign, reset };
}
