"use client";

/**
 * The person's own wallet, in the browser: find the installed wallets (EIP-6963), sign in with one (SIWE), and send the
 * transactions the API prepares (cosign, cancel, setup) from it. Nothing here holds a key; the wallet asks every time.
 */
import { useCallback, useEffect, useState } from "react";
import { createPublicClient, createWalletClient, custom, defineChain, getAddress, http, toHex, type EIP1193Provider, type Hash } from "viem";
import { createSiweMessage } from "viem/siwe";
import { api, type Me, type PreparedTx } from "./api";

export const ARC = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
  testnet: true,
});
const reader = createPublicClient({ chain: ARC, transport: http(), pollingInterval: 700 });

/** A browser wallet that announced itself: its own name and icon, and its provider. */
export type FoundWallet = { id: string; name: string; icon: string; rdns: string; provider: EIP1193Provider };

type Announce = CustomEvent<{ info: { uuid: string; name: string; icon: string; rdns: string }; provider: EIP1193Provider }>;
const found = new Map<string, FoundWallet>();
const listeners = new Set<() => void>();
let listening = false;

function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("eip6963:announceProvider", (e) => {
    const { info, provider } = (e as Announce).detail;
    if (found.has(info.rdns)) return;
    found.set(info.rdns, { id: info.uuid, name: info.name, icon: info.icon, rdns: info.rdns, provider });
    for (const l of listeners) l();
  });
}

/** Ask every installed wallet to announce itself (reading this never opens a wallet). */
function requestWallets() {
  listen();
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/** A wallet that only sets window.ethereum shows up as "Browser wallet". */
function legacyWallet(): FoundWallet | null {
  const eth = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  return eth ? { id: "legacy", name: "Browser wallet", icon: "", rdns: "legacy", provider: eth } : null;
}

/** The wallets in this browser, found the same way the design board did (now with their providers, so they connect). */
export function useWalletProviders(scanMs = 1400) {
  const [wallets, setWallets] = useState<FoundWallet[]>([]);
  const [scanning, setScanning] = useState(true);
  const [round, setRound] = useState(0);

  useEffect(() => {
    const update = () => setWallets([...found.values()]);
    listeners.add(update);
    requestWallets();
    const done = setTimeout(() => {
      const legacy = legacyWallet();
      if (!found.size && legacy) found.set("legacy", legacy);
      update();
      setScanning(false);
    }, scanMs);
    return () => {
      listeners.delete(update);
      clearTimeout(done);
    };
  }, [round, scanMs]);

  const rescan = useCallback(() => {
    found.clear();
    setWallets([]);
    setScanning(true);
    setRound((r) => r + 1);
  }, []);

  return { wallets, scanning, rescan };
}

const KEY = "cosign-wallet";
type Remembered = { rdns: string; name: string };
function remember(w: FoundWallet) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ rdns: w.rdns, name: w.name } satisfies Remembered));
  } catch {
    /* blocked storage: the next approval asks which wallet again */
  }
}
/** The wallet the person signed in with (its name shows in the account menu). */
export function rememberedWallet(): Remembered | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Remembered) : null;
  } catch {
    return null;
  }
}

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The wallet shares its address (it opens and asks the person). */
export async function connectWallet(w: FoundWallet): Promise<`0x${string}`> {
  const accounts = (await w.provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.length) throw new Error("The wallet didn't share an address.");
  return getAddress(accounts[0]);
}

/** Sign one message (Sign-In with Ethereum, for this site, on Arc testnet); the server sets the session cookie. */
export async function signInWith(w: FoundWallet, address: `0x${string}`): Promise<Me> {
  const { nonce } = await api.nonce();
  const message = createSiweMessage({
    address,
    chainId: ARC.id,
    domain: window.location.host,
    nonce,
    uri: window.location.origin,
    version: "1",
    statement: "Sign in to Cosign. This costs nothing and sends no transaction.",
    issuedAt: new Date(),
  });
  const signature = await createWalletClient({ account: address, transport: custom(w.provider) }).signMessage({ account: address, message });
  const me = await api.verify(message, signature);
  remember(w);
  return me;
}

/** Put the wallet on Arc testnet (adding the network first if the wallet doesn't know it). */
async function onArc(provider: EIP1193Provider) {
  const id = Number.parseInt(String(await provider.request({ method: "eth_chainId" })), 16);
  if (id === ARC.id) return;
  const chainId = toHex(ARC.id);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== 4902 && !/unrecognized|not added|unknown chain/i.test(String((e as Error).message))) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId, chainName: ARC.name, nativeCurrency: ARC.nativeCurrency, rpcUrls: ARC.rpcUrls.default.http, blockExplorerUrls: [ARC.blockExplorers.default.url] }],
    });
  }
}

/** The wallet the person signed in with, found again in this browser (or the only one there is). */
async function signer(): Promise<FoundWallet> {
  const want = rememberedWallet();
  requestWallets();
  for (let i = 0; i < 15; i++) {
    const w = want ? found.get(want.rdns) : undefined;
    if (w) return w;
    await new Promise((r) => setTimeout(r, 100));
  }
  const all = [...found.values()];
  const legacy = legacyWallet();
  if (want?.rdns === "legacy" && legacy) return legacy;
  if (all.length === 1) return all[0];
  if (!all.length && legacy) return legacy;
  throw new Error(want ? `Open ${want.name}, the wallet you signed in with.` : "No wallet found in this browser.");
}

/**
 * Send a transaction the API prepared, from the person's own wallet, and wait until Arc has it. `step` reports where it
 * is: 0 connecting to the wallet, 1 waiting for the signature, 2 sending it to Arc.
 */
export async function sendPrepared(tx: PreparedTx, me: string, step?: (i: number) => void): Promise<Hash> {
  step?.(0);
  const w = await signer();
  const accounts = (await w.provider.request({ method: "eth_requestAccounts" })) as string[];
  const account = accounts?.[0];
  if (!account) throw new Error("The wallet didn't share an address.");
  if (account.toLowerCase() !== me.toLowerCase()) throw new Error(`Your wallet is on ${shortAddr(account)}. Switch it to ${shortAddr(me)}, the address you signed in with.`);
  await onArc(w.provider);
  step?.(1);
  const from = getAddress(account);
  const hash = await createWalletClient({ account: from, chain: ARC, transport: custom(w.provider) }).sendTransaction({
    account: from,
    chain: ARC,
    to: tx.to,
    data: tx.data === "0x" ? undefined : tx.data,
    value: BigInt(tx.value),
  });
  step?.(2);
  const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 750 }); // about Arc's block time
  if (receipt.status !== "success") throw new Error(`The transaction failed on Arc (${shortAddr(hash)}).`);
  return hash;
}

/** "User rejected" from any wallet, said plainly. */
export function walletErrorText(e: unknown): string {
  const err = e as { code?: number; shortMessage?: string; message?: string };
  if (err.code === 4001 || /user (rejected|denied)|rejected the request/i.test(err.message ?? "")) return "You declined in your wallet. Nothing was signed.";
  return err.shortMessage ?? err.message ?? "Something went wrong in the wallet.";
}
