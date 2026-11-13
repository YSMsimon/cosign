/**
 * Step 1: create a Circle wallet set + two dev-controlled EOA wallets on Arc testnet,
 * fund the test-CFO wallet from Circle's faucet, and send 1 USDC CFO -> Clerk.
 *
 * Run: pnpm tsx --env-file=.env.local scripts/01-setup-wallets.ts
 * Re-running is safe: wallet ids are cached in data/wallets.local.json (gitignored).
 */
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { createPublicClient, defineChain, erc20Abi, formatUnits, http } from "viem";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing in .env.local`);
  return v;
};

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [env("ARC_RPC_URL")] } },
  blockExplorers: { default: { name: "Arcscan", url: "https://explorer.testnet.arc.io" } },
});
const USDC = env("USDC_ADDRESS") as `0x${string}`;
const chain = createPublicClient({ chain: arcTestnet, transport: http() });
const circle = initiateDeveloperControlledWalletsClient({
  apiKey: env("CIRCLE_API_KEY"),
  entitySecret: env("CIRCLE_ENTITY_SECRET"),
});

type W = { id: string; address: string; name: string; refId: string };
type Store = { walletSetId: string; wallets: W[] };
const STORE = "data/wallets.local.json";

async function ensureWallets(): Promise<Store> {
  if (existsSync(STORE)) return JSON.parse(readFileSync(STORE, "utf8"));
  const set = await circle.createWalletSet({ name: "ubc-hackathon-2026" });
  const walletSetId = set.data!.walletSet!.id!;
  const res = await circle.createWallets({
    walletSetId,
    blockchains: ["ARC-TESTNET"],
    count: 2,
    accountType: "EOA",
    metadata: [
      { name: "Test CFO", refId: "test-cfo" },
      { name: "Clerk", refId: "agent-ap-clerk" },
    ],
  });
  const wallets = res.data!.wallets!.map((w) => ({
    id: w.id!, address: w.address!, name: w.name ?? "", refId: w.refId ?? "",
  }));
  mkdirSync("data", { recursive: true });
  const store = { walletSetId, wallets };
  writeFileSync(STORE, JSON.stringify(store, null, 2));
  return store;
}

const usdcOf = async (a: string) =>
  formatUnits(await chain.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a as `0x${string}`] }), 6);

async function main() {
  const { wallets } = await ensureWallets();
  const cfo = wallets.find((w) => w.refId === "test-cfo")!;
  const clerk = wallets.find((w) => w.refId === "agent-ap-clerk")!;
  console.log(`Test CFO : ${cfo.address}\nClerk : ${clerk.address}`);

  if (Number(await usdcOf(cfo.address)) < 2) {
    console.log("Requesting testnet USDC from Circle faucet for the test CFO...");
    try {
      await circle.requestTestnetTokens({ address: cfo.address, blockchain: "ARC-TESTNET", usdc: true });
    } catch (err) {
      const e = err as { message?: string; response?: { status?: number; data?: unknown } };
      console.log("Faucet API error:", e?.response?.status, JSON.stringify(e?.response?.data ?? e?.message));
    }
    for (let i = 0; i < 20 && Number(await usdcOf(cfo.address)) < 1; i++) await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`Balances -> CFO ${await usdcOf(cfo.address)} USDC | Clerk ${await usdcOf(clerk.address)} USDC`);
  if (Number(await usdcOf(cfo.address)) < 1) {
    console.log("CFO wallet not funded yet. Use https://faucet.circle.com (Arc Testnet, USDC) with the CFO address above, then re-run.");
    return;
  }

  // Find Circle's token id for USDC on this wallet, then transfer 1 USDC CFO -> Clerk.
  const bal = await circle.getWalletTokenBalance({ id: cfo.id });
  const usdcToken = bal.data?.tokenBalances?.find((t) => t.token?.symbol?.toUpperCase().startsWith("USDC"))?.token;
  if (!usdcToken?.id) throw new Error("USDC token id not found in Circle balances: " + JSON.stringify(bal.data));
  const tx = await circle.createTransaction({
    walletId: cfo.id,
    tokenId: usdcToken.id,
    destinationAddress: clerk.address,
    amount: ["1"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    refId: "step1-test-transfer",
  });
  const txId = tx.data!.id!;
  const done = await circle.getTransaction({ id: txId, waitForTxHash: true });
  const hash = done.data?.transaction?.txHash;
  console.log(`Transfer 1 USDC CFO -> Clerk: ${hash}\n${arcTestnet.blockExplorers.default.url}/tx/${hash}`);
  await new Promise((r) => setTimeout(r, 2000));
  console.log(`Balances -> CFO ${await usdcOf(cfo.address)} USDC | Clerk ${await usdcOf(clerk.address)} USDC`);
}

main().catch((e) => {
  console.error("FAILED:", e?.response?.status ?? "", JSON.stringify(e?.response?.data ?? e?.message ?? e));
  process.exit(1);
});
