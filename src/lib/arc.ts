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
import { sqlite } from "./db";

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
/** How often to look for a receipt: about Arc's block time (viem's default is 4 s, which a voice turn hears as silence). */
export const RECEIPT_POLL_MS = 750;
export const explorerAddr = (a: string) => `${arcTestnet.blockExplorers.default.url}/address/${a}`;

// Arc confirms in well under a second; viem's default 4 s polling made every transaction wait up to 4 s extra.
// the public RPC rate-limits bursts (429): retry with backoff (0.3, 0.6, 1.2, 2.4 s) before giving up
export const chain = createPublicClient({ chain: arcTestnet, transport: http(undefined, { retryCount: 4, retryDelay: 300 }), pollingInterval: 500 });

let _circle: ReturnType<typeof initiateDeveloperControlledWalletsClient> | undefined;
export const circle = () =>
  (_circle ??= initiateDeveloperControlledWalletsClient({
    apiKey: env("CIRCLE_API_KEY"),
    entitySecret: env("CIRCLE_ENTITY_SECRET"),
  }));

export type WalletRef = { id: string; address: Address; refId: string; name?: string };
/** Demo and script wallets (data/wallets.local.json). Agents created through the API live in the database. */
export function wallets(): WalletRef[] {
  return JSON.parse(readFileSync("data/wallets.local.json", "utf8")).wallets;
}
function agentWalletFromDb(refId: string): WalletRef | undefined {
  try {
    const row = sqlite().prepare("SELECT wallet_id, wallet_address, name FROM agents WHERE ref = ?").get(refId) as
      | { wallet_id: string; wallet_address: string; name: string }
      | undefined;
    return row && { id: row.wallet_id, address: row.wallet_address as Address, refId, name: row.name };
  } catch {
    return undefined;
  }
}
export function findWallet(refId: string): WalletRef | undefined {
  return wallets().find((x) => x.refId === refId) ?? agentWalletFromDb(refId);
}
export function wallet(refId: string): WalletRef {
  const w = findWallet(refId);
  if (!w) throw new Error(`no Circle wallet with refId "${refId}"`);
  return w;
}

/** Create a Circle developer-controlled EOA on Arc testnet in our wallet set (no local file write). */
export async function createCircleWallet(refId: string, name: string): Promise<WalletRef> {
  const store = JSON.parse(readFileSync("data/wallets.local.json", "utf8")) as { walletSetId: string };
  const res = await circle().createWallets({
    walletSetId: store.walletSetId,
    blockchains: ["ARC-TESTNET"],
    count: 1,
    accountType: "EOA",
    metadata: [{ name: name.replace(/[(),]/g, "").slice(0, 50) || refId, refId }], // Circle rejects ( ) , in names
  });
  const c = res.data!.wallets![0];
  const w: WalletRef = { id: c.id!, address: c.address! as Address, refId, name };
  await watchAddresses({ wallets: [w.address] }).catch(() => {});
  return w;
}

/** Native USDC balance (18 decimals on Arc), for gas checks. */
export const nativeBalance = (a: Address) => chain.getBalance({ address: a });

export const usd = (n: number | string) => parseUnits(String(n), USDC_DECIMALS);
export const fmt = (v: bigint) => formatUnits(v, USDC_DECIMALS);

export async function usdcBalance(addr: Address) {
  return chain.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [addr] });
}

const FEE = { type: "level", config: { feeLevel: "MEDIUM" } } as const;

/** The treasury contract's errors by selector, in words (a revert names one of these). */
const TREASURY_ERRORS: Record<string, string> = {
  "0xf4d678b8": "InsufficientBalance (the treasury has too little USDC)",
  "0x6015fb13": "AllowanceExceeded (over the weekly petty-cash allowance)",
  "0x2bb9acf7": "BadInput",
  "0x1309a563": "IsPaused (the treasury is paused)",
  "0x65f84cc0": "NotApprover",
  "0x7d1b73b9": "NotProposer (this wallet may not draft)",
  "0x1446e503": "ProposalClosed (already executed or cancelled)",
  "0x101f817a": "AlreadyApproved",
  "0x5d5d3ca0": "UnknownProposal",
};

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
      const done = await circle().getTransaction({ id: tx.data!.id!, waitForTxHash: true, pollingInterval: 300 }); // SDK default: 1 s
      hash = done.data!.transaction!.txHash as Hash;
    } catch (e) {
      // Circle can estimate gas on a node a block or two behind ours, so a call that depends on the
      // previous tx (approve right after propose) reverts in estimation. Nothing was broadcast, so
      // retrying is safe. Seen 2026-11-13: approve → UnknownProposal() one block after propose.
      // A definite refusal (too little in the treasury, over the allowance, not allowed) fails at once, named.
      const msg = String((e as Error)?.message ?? e);
      const known = Object.entries(TREASURY_ERRORS).find(([sel]) => msg.includes(sel));
      if (known && known[0] !== "0x5d5d3ca0") throw new Error(`${functionName} was refused by the treasury: ${known[1]}`);
      if (attempt < 3 && /ESTIMATION_ERROR/.test(msg)) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  const receipt = await chain.waitForTransactionReceipt({ hash, pollingInterval: RECEIPT_POLL_MS });
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
  await chain.waitForTransactionReceipt({ hash, pollingInterval: RECEIPT_POLL_MS });
  return hash;
}

// ─────────────── treasury helpers (what the agent tools will call) ───────────────

export type ChainProposal = { kind: number; to: string; amount: bigint; newThreshold: number; proposer: string; createdAt: bigint; approvals: number; executed: boolean; cancelled: boolean; memo: string };
const gp = globalThis as unknown as { __cosignFinalProposals?: Map<string, ChainProposal> };
const finals = (gp.__cosignFinalProposals ??= new Map());

/** One proposal from the treasury. Executed and cancelled ones never change again, so each is read from Arc once. */
export async function readProposal(treasury: Address, pid: bigint): Promise<ChainProposal> {
  const key = `${treasury.toLowerCase()}:${pid}`;
  const hit = finals.get(key);
  if (hit) return hit;
  const p = (await chain.readContract({ address: treasury, abi: companyTreasuryAbi, functionName: "getProposal", args: [pid] })) as ChainProposal;
  if (p.executed || p.cancelled) finals.set(key, p);
  return p;
}

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
  const w = await createCircleWallet(refId, name);
  const store = JSON.parse(readFileSync("data/wallets.local.json", "utf8")) as { walletSetId: string; wallets: WalletRef[] };
  store.wallets.push(w);
  writeFileSync("data/wallets.local.json", JSON.stringify(store, null, 2));
  return w;
}
