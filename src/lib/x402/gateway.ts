/**
 * Circle Gateway Nanopayments for our agents (buyer side), following Circle's
 * "Pay for resources with nanopayments" quickstart (Circle Wallets tab):
 *  - one-time deposit: USDC.approve(GatewayWallet) + GatewayWallet.deposit(USDC, amount)
 *  - per payment: BatchEvmScheme builds an EIP-3009 authorization against the GatewayWallet
 *    contract; the agent's developer-controlled EOA signs it through Circle (no private key here).
 * Server-only.
 */
import { BatchEvmScheme, CHAIN_CONFIGS } from "@circle-fin/x402-batching/client";
import type { Address, Hex } from "viem";
import { circle, wallet } from "../arc";

export const ARC = CHAIN_CONFIGS.arcTestnet;
const ARC_USDC = ARC.tokens.USDC!.address; // v4 config: tokens.USDC (the docs example uses an older `chain.usdc`)
export const ARC_GATEWAY_DOMAIN = 26;
export const GATEWAY_API = "https://gateway-api-testnet.circle.com";
const FEE = { type: "level", config: { feeLevel: "MEDIUM" } } as const;

const stringifyTypedData = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

/** Gateway balance (USDC, as a decimal number) for an address on Arc testnet. */
export async function gatewayBalance(depositor: Address): Promise<number> {
  const res = await fetch(`${GATEWAY_API}/v1/balances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "USDC", sources: [{ domain: ARC_GATEWAY_DOMAIN, depositor }] }),
  });
  if (!res.ok) throw new Error(`Gateway balance request failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { balances: { domain: number; balance: string }[] };
  return Number(json.balances.find((b) => b.domain === ARC_GATEWAY_DOMAIN)?.balance ?? "0");
}

async function waitCircleTx(id: string) {
  for (;;) {
    const r = await circle().getTransaction({ id });
    const s = r.data?.transaction?.state;
    if (s === "COMPLETE" || s === "CONFIRMED") return r.data!.transaction!.txHash as Hex;
    if (s === "FAILED" || s === "DENIED" || s === "CANCELLED") throw new Error(`Circle tx ${id} ended ${s}`);
    await new Promise((r) => setTimeout(r, 2500));
  }
}

/** Make sure an agent wallet has at least `minUsd` in Gateway; deposit `depositUsd` if not. */
export async function ensureGatewayBalance(agentRef: string, minUsd: number, depositUsd: string) {
  const w = wallet(agentRef);
  let bal = await gatewayBalance(w.address);
  if (bal >= minUsd) return { balance: bal, deposited: null as null | { approveTx: Hex; depositTx: Hex } };

  const atomic = BigInt(Math.round(Number(depositUsd) * 1e6)).toString();
  const approve = await circle().createContractExecutionTransaction({
    walletId: w.id,
    contractAddress: ARC_USDC,
    abiFunctionSignature: "approve(address,uint256)",
    abiParameters: [ARC.gatewayWallet, atomic],
    fee: FEE,
  });
  const approveTx = await waitCircleTx(approve.data!.id!);
  const deposit = await circle().createContractExecutionTransaction({
    walletId: w.id,
    contractAddress: ARC.gatewayWallet,
    abiFunctionSignature: "deposit(address,uint256)",
    abiParameters: [ARC_USDC, atomic],
    fee: FEE,
  });
  const depositTx = await waitCircleTx(deposit.data!.id!);
  for (let i = 0; i < 60 && bal < minUsd; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    bal = await gatewayBalance(w.address);
  }
  return { balance: bal, deposited: { approveTx, depositTx } };
}

/** BatchEvmScheme whose signer is the agent's Circle developer-controlled EOA. */
export function batchSchemeFor(agentRef: string) {
  const w = wallet(agentRef);
  return new BatchEvmScheme({
    address: w.address,
    signTypedData: async (params) => {
      const typedData = {
        domain: { ...params.domain, chainId: params.domain.chainId.toString() },
        primaryType: params.primaryType,
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          ...params.types,
        },
        message: params.message,
      };
      const res = await circle().signTypedData({ walletId: w.id, data: stringifyTypedData(typedData) });
      const sig = res.data?.signature;
      if (!sig) throw new Error("Circle Wallets returned no signature");
      return (sig.startsWith("0x") ? sig : `0x${sig}`) as Hex;
    },
  });
}
