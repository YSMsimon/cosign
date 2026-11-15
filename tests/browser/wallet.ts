/**
 * A throwaway wallet injected into the page for the test only: an EIP-1193 provider that announces itself over
 * EIP-6963 as "Test Wallet". Its key stays in the test process; the page asks it to sign through an exposed binding.
 * Nothing like this exists in the app.
 */
import type { Page } from "@playwright/test";
import { createWalletClient, http, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { arcTestnet } from "../../src/lib/arc";

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.io";
type Err = { __error: true; code: number; message: string };

export type WalletLog = { method: string; at: number }[];

async function rpc(method: string, params: unknown[]) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: unknown; error?: { code: number; message: string } };
  if (j.error) return { __error: true, code: j.error.code, message: j.error.message } satisfies Err;
  return j.result;
}

export async function injectWallet(page: Page, account: PrivateKeyAccount, o: { decline?: () => boolean } = {}) {
  const log: WalletLog = [];
  const client = createWalletClient({ account, chain: arcTestnet, transport: http(RPC) });
  await page.exposeBinding("__cosignWallet", async (_src, method: string, params: unknown[]) => {
    log.push({ method, at: Date.now() });
    try {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account.address];
        case "eth_chainId":
          return `0x${arcTestnet.id.toString(16)}`;
        case "net_version":
          return String(arcTestnet.id);
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
          return null;
        case "personal_sign": {
          if (o.decline?.()) return { __error: true, code: 4001, message: "User rejected the request." } satisfies Err;
          const [data] = params as [Hex, string];
          return await account.signMessage({ message: { raw: data } });
        }
        case "eth_sendTransaction": {
          if (o.decline?.()) return { __error: true, code: 4001, message: "User rejected the request." } satisfies Err;
          const [tx] = params as [{ to: Hex; data?: Hex; value?: Hex }];
          return await client.sendTransaction({ account, chain: arcTestnet, to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n });
        }
        default:
          return await rpc(method, params);
      }
    } catch (e) {
      return { __error: true, code: -32603, message: (e as Error).message } satisfies Err;
    }
  });
  await page.addInitScript(() => {
    type Call = (method: string, params: unknown[]) => Promise<unknown>;
    const call = (window as unknown as { __cosignWallet: Call }).__cosignWallet;
    const provider = {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        const r = (await call(method, params ?? [])) as { __error?: boolean; code?: number; message?: string } | unknown;
        if (r && typeof r === "object" && (r as { __error?: boolean }).__error) {
          const e = new Error((r as { message: string }).message) as Error & { code?: number };
          e.code = (r as { code: number }).code;
          throw e;
        }
        return r;
      },
      on() {},
      removeListener() {},
    };
    const info = { uuid: "cosign-test-wallet", name: "Test Wallet", icon: "", rdns: "dev.cosign.testwallet" };
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  });
  return log;
}
