/**
 * Server-side helpers for Arc testnet + Circle developer-controlled wallets.
 * Used by scripts now and by the agent's tools later. Never import this into client code.
 */
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  parseUnits,
  type Abi,
  type Address,
  type Hash,
} from "viem";
import { readFileSync, writeFileSync } from "node:fs";
import { companyTreasuryAbi, treasuryFactoryAbi, TREASURY_FACTORY_ADDRESS } from "./contracts/abis";
import { watchAddresses } from "./quicknode/kv";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing (load .env.local)`);
  return v;
};

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "Arcscan", url: "https://explorer.testnet.arc.io" } },
});
export const USDC = (process.env.USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000") as Address;
export const USDC_DECIMALS = 6;
export const explorerTx = (h: string) => `${arcTestnet.blockExplorers.default.url}/tx/${h}`;
export const explorerAddr = (a: string) => `${arcTestnet.blockExplorers.default.url}/address/${a}`;

export const chain = createPublicClient({ chain: arcTestnet, transport: http() });

let _circle: ReturnType<typeof initiateDeveloperControlledWalletsClient> | undefined;
export const circle = () =>
  (_circle ??= initiateDeveloperControlledWalletsClient({
    apiKey: env("CIRCLE_API_KEY"),
    entitySecret: env("CIRCLE_ENTITY_SECRET"),
  }));

export type WalletRef = { id: string; address: Address; refId: string; name?: string };
export function wallets(): WalletRef[] {
  return JSON.parse(readFileSync("data/wallets.local.json", "utf8")).wallets;
}
export function wallet(refId: string): WalletRef {
  const w = wallets().find((x) => x.refId === refId);
  if (!w) throw new Error(`no Circle wallet with refId "${refId}"`);
  return w;
}

export const usd = (n: number | string) => parseUnits(String(n), USDC_DECIMALS);
export const fmt = (v: bigint) => formatUnits(v, USDC_DECIMALS);

export async function usdcBalance(addr: Address) {
  return chain.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [addr] });
}

const FEE = { type: "level", config: { feeLevel: "MEDIUM" } } as const;

/** Send a contract call from one of our Circle wallets and wait for it to be mined. */
export async function callFrom<const A extends Abi>(
  refId: string,
  contract: Address,
  abi: A,
  functionName: string,
  args: readonly unknown[],
) {
  const w = wallet(refId);
  const callData = encodeFunctionData({ abi: abi as Abi, functionName, args } as never);
  let hash: Hash | undefined;
  for (let attempt = 0; !hash; attempt++) {
    const tx = await circle().createContractExecutionTransaction({
      walletId: w.id,
      contractAddress: contract,
      callData,
      fee: FEE,
    });
    try {
      const done = await circle().getTransaction({ id: tx.data!.id!, waitForTxHash: true });
      hash = done.data!.transaction!.txHash as Hash;
    } catch (e) {
      // Circle can estimate gas on a node a block or two behind ours, so a call that depends on the
      // previous tx (approve right after propose) reverts in estimation. Nothing was broadcast, so
      // retrying is safe. Seen 2026-11-13: approve → UnknownProposal() one block after propose.
      if (attempt < 3 && /ESTIMATION_ERROR/.test(String((e as Error)?.message ?? e))) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  const receipt = await chain.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${explorerTx(hash)}`);
  return { hash, receipt };
}

/** Plain USDC transfer from one of our Circle wallets. */
export async function sendUsdc(refId: string, to: Address, amount: string) {
  const w = wallet(refId);
  const bal = await circle().getWalletTokenBalance({ id: w.id });
  const token = bal.data?.tokenBalances?.find((t) => t.token?.symbol?.toUpperCase().startsWith("USDC"))?.token;
  if (!token?.id) throw new Error("USDC token not found in Circle balances");
  const tx = await circle().createTransaction({
    walletId: w.id,
    tokenId: token.id,
    destinationAddress: to,
    amount: [amount],
    fee: FEE,
  });
  const done = await circle().getTransaction({ id: tx.data!.id!, waitForTxHash: true });
  const hash = done.data!.transaction!.txHash as Hash;
  await chain.waitForTransactionReceipt({ hash });
  return hash;
}

// ─────────────── treasury helpers (what the agent tools will call) ───────────────

export async function createCompany(
  creatorRef: string,
  name: string,
  approvers: Address[],
  proposers: Address[],
  threshold: number,
) {
  const { hash, receipt } = await callFrom(creatorRef, TREASURY_FACTORY_ADDRESS, treasuryFactoryAbi, "createTreasury", [
    name,
    approvers,
    proposers,
    threshold,
  ]);
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: treasuryFactoryAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "TreasuryCreated") {
        const treasury = ev.args.treasury as Address;
        // watch it before its first proposal can land (the webhook also adds it, as a backstop)
        await watchAddresses({ treasuries: [treasury] }).catch((e) => console.error("[quicknode] watch failed:", e?.message));
        return { treasury, hash };
      }
    } catch {}
  }
  throw new Error("TreasuryCreated event not found");
}

export async function proposePayment(fromRef: string, treasury: Address, to: Address, amountUsd: string, memo: string) {
  const { hash, receipt } = await callFrom(fromRef, treasury, companyTreasuryAbi, "propose", [to, usd(amountUsd), memo]);
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: companyTreasuryAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "ProposalCreated") return { id: ev.args.id as bigint, hash };
    } catch {}
  }
  throw new Error("ProposalCreated event not found");
}

export const approvePayment = (approverRef: string, treasury: Address, id: bigint) =>
  callFrom(approverRef, treasury, companyTreasuryAbi, "approve", [id]);

export const setAgentAllowance = (approverRef: string, treasury: Address, agent: Address, perPeriodUsd: string, periodSec: number) =>
  callFrom(approverRef, treasury, companyTreasuryAbi, "setAgentAllowance", [agent, usd(perPeriodUsd), BigInt(periodSec)]);

export const topUpAgent = (agentRef: string, treasury: Address, amountUsd: string) =>
  callFrom(agentRef, treasury, companyTreasuryAbi, "topUpAgent", [usd(amountUsd)]);

export async function treasuryState(treasury: Address) {
  const [name, threshold, paused, count, bal] = await Promise.all([
    chain.readContract({ address: treasury, abi: companyTreasuryAbi, functionName: "name" }),
    chain.readContract({ address: treasury, abi: companyTreasuryAbi, functionName: "threshold" }),
    chain.readContract({ address: treasury, abi: companyTreasuryAbi, functionName: "paused" }),
    chain.readContract({ address: treasury, abi: companyTreasuryAbi, functionName: "proposalCount" }),
    usdcBalance(treasury),
  ]);
  return { name, threshold, approvers: await approversOf(treasury), paused, proposalCount: count, balance: fmt(bal) };
}

export const availableAllowance = async (treasury: Address, agent: Address) =>
  fmt(await chain.readContract({ address: treasury, abi: companyTreasuryAbi, functionName: "availableAllowance", args: [agent] }));

// ─────────────────────────── roles, pause, cancel (approver actions) ───────────────────────────

export const setGuardian = (approverRef: string, treasury: Address, account: Address, enabled = true) =>
  callFrom(approverRef, treasury, companyTreasuryAbi, "setGuardian", [account, enabled]);
export const unpauseTreasury = (approverRef: string, treasury: Address) => callFrom(approverRef, treasury, companyTreasuryAbi, "unpause", []);
export const cancelProposal = (ref: string, treasury: Address, id: bigint) => callFrom(ref, treasury, companyTreasuryAbi, "cancel", [id]);

export const APPROVER_CHANGE = { add: 1, remove: 2, threshold: 3 } as const; // CompanyTreasury.Kind

/** An approver proposes adding/removing an approver or changing the threshold; it executes after enough cosigns. */
export async function proposeApproverChange(
  approverRef: string,
  treasury: Address,
  kind: keyof typeof APPROVER_CHANGE,
  account: Address,
  newThreshold = 0,
  memo = "",
) {
  const { hash, receipt } = await callFrom(approverRef, treasury, companyTreasuryAbi, "proposeApproverChange", [APPROVER_CHANGE[kind], account, newThreshold, memo]);
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: companyTreasuryAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "ApproverChangeProposed") return { id: ev.args.id as bigint, hash };
    } catch {}
  }
  throw new Error("ApproverChangeProposed event not found");
}
export const approversOf = (treasury: Address) =>
  chain.readContract({ address: treasury, abi: companyTreasuryAbi, functionName: "approvers" }) as Promise<readonly Address[]>;
export const isPaused = (treasury: Address) => chain.readContract({ address: treasury, abi: companyTreasuryAbi, functionName: "paused" }) as Promise<boolean>;
export const isGuardian = (treasury: Address, account: Address) =>
  chain.readContract({ address: treasury, abi: companyTreasuryAbi, functionName: "isGuardian", args: [account] }) as Promise<boolean>;

/** Get a Circle wallet by refId, creating it in our wallet set if it does not exist yet. */
export async function ensureWallet(refId: string, name: string): Promise<WalletRef> {
  const existing = wallets().find((x) => x.refId === refId);
  if (existing) return existing;
  const store = JSON.parse(readFileSync("data/wallets.local.json", "utf8")) as { walletSetId: string; wallets: WalletRef[] };
  const res = await circle().createWallets({
    walletSetId: store.walletSetId,
    blockchains: ["ARC-TESTNET"],
    count: 1,
    accountType: "EOA",
    metadata: [{ name, refId }],
  });
  const c = res.data!.wallets![0];
  const w: WalletRef = { id: c.id!, address: c.address! as Address, refId, name };
  store.wallets.push(w);
  writeFileSync("data/wallets.local.json", JSON.stringify(store, null, 2));
  await watchAddresses({ wallets: [w.address] }).catch(() => {});
  return w;
}
