/**
 * Circle App Kit for an agent's own wallet on Arc testnet, plus the onramp session for people. Every wallet action
 * signs through the Circle Wallets adapter with our API key and entity secret, so the agent's developer-controlled
 * wallet signs; we never hold a private key. The agent tools (agent/tools.ts) check the agent's rules first.
 *
 *   send            kit.send                       tokens to an address on Arc
 *   swap            kit.estimateSwap / kit.swap    USDC into EURC (cirBTC has no route on Arc testnet, 2026-11-15)
 *   bridge          kit.estimateBridge / bridge    USDC to another chain over CCTP; Circle's forwarder mints there
 *   gateway         kit.unifiedBalance             deposit into the wallet's Gateway balance (what nanopayments spend)
 *   earn            kit.earn                       deposit into / withdraw from an Earn vault (Morpho on Arc testnet)
 *   borrow          kit.borrow                     markets and quotes only: App Kit borrows only from batch-capable
 *                                                  (smart-contract) wallets, and agent wallets are EOAs (tested 2026-11-15)
 *   onramp          app-kit/server                 a sandbox session whose widget a PERSON completes in a browser
 * Server-only.
 */
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";
import { AppKit, getErrorCode, isKitError } from "@circle-fin/app-kit";
import type { Address } from "viem";

const CHAIN = "Arc_Testnet" as const;
export const EXPLORER_TX = "https://explorer.testnet.arc.io/tx/";

const g = globalThis as unknown as { __cosignAppKit?: AppKit; __cosignKitAdapter?: ReturnType<typeof createCircleWalletsAdapter> };
const kit = () => (g.__cosignAppKit ??= new AppKit());
function adapter() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) throw new Error("CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET are needed for App Kit");
  return (g.__cosignKitAdapter ??= createCircleWalletsAdapter({ apiKey, entitySecret }));
}
const from = (address: Address) => ({ adapter: adapter(), chain: CHAIN, address });
const apiKeyConfig = () => (process.env.CIRCLE_API_KEY ? { apiKey: process.env.CIRCLE_API_KEY } : {});
/* App Kit's typings are generic over adapter capabilities; the shapes below follow its docs and d.ts */
type Loose = never;

/** A short, honest reason from an App Kit error (its code and name when it has one). */
export function kitErrorText(e: unknown): string {
  if (isKitError(e)) return `${e.name}${getErrorCode(e) ? ` (${getErrorCode(e)})` : ""}: ${e.message}`;
  return (e as Error)?.message ?? String(e);
}
const sum = (xs: { amount?: string; fee?: string }[] = []) => xs.reduce((n, x) => n + Number(x.amount ?? x.fee ?? 0), 0);

// ───────────── send and swap ─────────────

/** Send `amount` of `token` (default USDC) from the agent's wallet to `to`, on Arc testnet. */
export async function kitSend(fromAddress: Address, to: Address, amount: string, token: "USDC" | "EURC" = "USDC") {
  const step = await kit().send({ from: from(fromAddress), to, amount, token });
  if (step.state === "error") throw new Error(step.errorMessage ?? "the transfer failed");
  return { txHash: step.txHash ?? null, explorerUrl: step.explorerUrl ?? (step.txHash ? `${EXPLORER_TX}${step.txHash}` : null), state: step.state };
}

type SwapIn = { from: Address; tokenOut: string; amountIn: string; slippageBps: number };
const swapParams = (o: SwapIn) =>
  ({ from: from(o.from), tokenIn: "USDC", tokenOut: o.tokenOut, amountIn: o.amountIn, config: { slippageBps: o.slippageBps, ...apiKeyConfig() } }) as Parameters<AppKit["swap"]>[0];

/** What a swap would give back: the expected amount and the minimum the price tolerance allows. */
export async function kitEstimateSwap(o: SwapIn) {
  const e = await kit().estimateSwap(swapParams(o));
  return { estimatedOut: e.estimatedOutput.amount, minimumOut: e.stopLimit.amount, token: e.estimatedOutput.token, toAddress: e.toAddress };
}

/** Swap USDC into `tokenOut`; the tokens come back to the same wallet (same-chain swap, no other recipient). */
export async function kitSwap(o: SwapIn) {
  const r = await kit().swap(swapParams(o));
  return { txHash: r.txHash, explorerUrl: r.explorerUrl ?? `${EXPLORER_TX}${r.txHash}`, amountIn: r.amountIn, toAddress: r.toAddress, fees: r.fees ?? [] };
}

// ───────────── bridge (CCTP) ─────────────

type BridgeIn = { from: Address; toChain: string; recipient: Address; amount: string };
const bridgeParams = (o: BridgeIn) => ({ from: from(o.from), to: { chain: o.toChain, recipientAddress: o.recipient, useForwarder: true }, amount: o.amount }) as Loose;

/** Fees for a bridge: Circle's forwarder fee (paid in USDC) and the source-chain gas. */
export async function kitEstimateBridge(o: BridgeIn) {
  const e = (await kit().estimateBridge(bridgeParams(o))) as unknown as { fees?: { amount: string }[]; gasFees?: { fees: { fee: string } }[] };
  return { feeUsd: sum(e.fees), gasUsd: sum((e.gasFees ?? []).map((x) => x.fees)) };
}

/** Bridge USDC from Arc to `toChain` for `recipient`; Circle's forwarder finishes the mint there (no gas needed on that chain). */
export async function kitBridge(o: BridgeIn) {
  const r = (await kit().bridge(bridgeParams(o))) as unknown as { state: string; steps?: { name: string; state: string; txHash?: string; explorerUrl?: string; errorMessage?: string }[] };
  const steps = (r.steps ?? []).map((s) => ({ name: s.name, state: s.state, tx: s.txHash ?? null, explorer: s.explorerUrl ?? null, error: s.errorMessage }));
  if (r.state === "error") throw new Error(steps.find((s) => s.error)?.error ?? "the bridge failed");
  return { state: r.state, steps };
}

// ───────────── Gateway (unified balance) ─────────────

/** The wallet's Gateway balance on Arc (what nanopayments spend). */
export async function kitGatewayBalance(address: Address) {
  const r = (await kit().unifiedBalance.getBalances({ token: "USDC", sources: { address, chains: [CHAIN] }, networkType: "testnet" } as Loose)) as unknown as { totalConfirmedBalance: string };
  return r.totalConfirmedBalance;
}

/** Move USDC from the wallet into its own Gateway balance on Arc. */
export async function kitGatewayDeposit(address: Address, amount: string) {
  const r = await kit().unifiedBalance.deposit({ from: from(address), amount, token: "USDC" } as Loose);
  return { txHash: r.txHash, explorerUrl: r.explorerUrl ?? `${EXPLORER_TX}${r.txHash}`, depositedTo: r.depositedTo };
}

// ───────────── Earn ─────────────

/** Earn vaults on Arc testnet for USDC (name, address, APY). */
export async function kitEarnVaults() {
  const r = await kit().earn.exploreVaults({ chain: CHAIN, pageSize: 100, ...({ config: apiKeyConfig() } as object) } as Loose);
  return (r as unknown as { vaults: { vaultAddress: string; name: string; protocol: string; asset: string; currentApy: number; status: string }[] }).vaults
    .filter((v) => v.asset === "USDC" && v.status === "active")
    .map((v) => ({ vault: v.vaultAddress.toLowerCase(), name: v.name, protocol: v.protocol, apyPct: Math.round(v.currentApy * 10000) / 100 }));
}
export async function kitEarnDeposit(address: Address, vault: string, amount: string) {
  const r = await kit().earn.deposit({ from: from(address), vaultAddress: vault, amount, config: apiKeyConfig() } as Loose);
  const x = r as unknown as { txHash: string; explorerUrl?: string };
  return { txHash: x.txHash, explorerUrl: x.explorerUrl ?? `${EXPLORER_TX}${x.txHash}` };
}
export async function kitEarnWithdraw(address: Address, vault: string, amount: string) {
  const r = await kit().earn.withdraw({ from: from(address), vaultAddress: vault, amount, config: apiKeyConfig() } as Loose);
  const x = r as unknown as { txHash: string; explorerUrl?: string };
  return { txHash: x.txHash, explorerUrl: x.explorerUrl ?? `${EXPLORER_TX}${x.txHash}` };
}
export async function kitEarnPosition(address: Address, vault: string) {
  const p = (await kit().earn.getPosition({ from: from(address), vaultAddress: vault, config: apiKeyConfig() } as Loose)) as unknown as {
    currentBalance?: string; principalDeposited?: string; totalYieldEarned?: string;
  };
  return { balance: p.currentBalance ?? "0", deposited: p.principalDeposited ?? "0", earned: p.totalYieldEarned ?? "0" };
}

// ───────────── Borrow ─────────────

/** Borrow markets on Arc testnet (what you borrow, against what). */
export async function kitBorrowMarkets() {
  const r = (await kit().borrow.exploreMarkets({ chain: CHAIN, pageSize: 20 } as Loose)) as unknown as {
    markets: { marketId: string; protocol: string; loanAsset: { symbol: string }; collateralAsset: { symbol: string }; borrowApy: number | null }[];
  };
  return r.markets.map((m) => ({ market: m.marketId.toLowerCase(), protocol: m.protocol, borrow: m.loanAsset.symbol, collateral: m.collateralAsset.symbol, borrowApyPct: m.borrowApy === null ? null : Math.round(m.borrowApy * 10000) / 100 }));
}
/** What a loan would need: the collateral, the fees, the health factor and the liquidation price. */
export async function kitBorrowQuote(address: Address, market: string, amount: string) {
  const q = (await kit().borrow.getBorrowQuote({ walletAddress: address, chain: CHAIN, marketId: market, borrowAmount: amount } as Loose)) as unknown as {
    collateralAmount: { token: string; amount: string }; loanAssetAmount: { token: string; amount: string }; borrowApy: number | null;
    resultingHealthFactor: number | null; liquidationPrice: { token: string; amount: string } | null; fees?: { amount?: string }[];
  };
  return {
    collateral: `${q.collateralAmount.amount} ${q.collateralAmount.token}`,
    borrow: `${q.loanAssetAmount.amount} ${q.loanAssetAmount.token}`,
    borrowApyPct: q.borrowApy === null ? null : Math.round(q.borrowApy * 10000) / 100,
    healthFactor: q.resultingHealthFactor,
    liquidationPrice: q.liquidationPrice ? `${q.liquidationPrice.amount} ${q.liquidationPrice.token}` : null,
  };
}

// ───────────── Onramp (for people) ─────────────

/**
 * A Circle onramp session for a PERSON to buy USDC into `destination` (always the workspace treasury; the caller
 * decides, never the agent). Sandbox when the API key is a TEST_API_KEY. The person completes it in Circle's widget.
 */
export async function createOnrampSession(o: { appUserId: string; destination: Address; amountUsd?: number }) {
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) throw new Error("CIRCLE_API_KEY is needed for the onramp");
  const sandbox = apiKey.startsWith("TEST_API_KEY");
  const { createAppServerKit } = await import("@circle-fin/app-kit/server");
  const server = createAppServerKit({
    onramp: {
      apiKey,
      ...(sandbox ? { baseUrl: "https://api-test.circle.com", widgetBaseUrl: "https://onramp-sandbox.arc.io" } : {}),
      ...(process.env.ONRAMP_REFERRER_DOMAIN ? { referrerDomain: process.env.ONRAMP_REFERRER_DOMAIN } : {}),
    },
  });
  const s = await server.onramp.createSession({
    appUserId: o.appUserId,
    destinationAddress: o.destination,
    destinationChain: CHAIN,
    ...(o.amountUsd ? { amount: String(o.amountUsd), currency: "USD" } : {}),
  } as Loose);
  return { widgetUrl: s.widgetUrl, sessionId: s.sessionId, expiresAt: s.expiresAt, sandbox };
}
