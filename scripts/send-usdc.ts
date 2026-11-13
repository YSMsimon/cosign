/**
 * Send USDC from one of our Circle wallets (by refId) to any address on Arc testnet.
 * Run: pnpm tsx --env-file=.env.local scripts/send-usdc.ts test-cfo 0xRecipient 1.5
 */
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { readFileSync } from "node:fs";

(async () => {
  const [fromRef, to, amount] = process.argv.slice(2);
  if (!fromRef || !to || !amount) throw new Error("usage: send-usdc.ts <fromRefId> <toAddress> <amount>");
  const circle = initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });
  const { wallets } = JSON.parse(readFileSync("data/wallets.local.json", "utf8")) as {
    wallets: { id: string; address: string; refId: string }[];
  };
  const from = wallets.find((w) => w.refId === fromRef);
  if (!from) throw new Error(`no wallet with refId ${fromRef}`);
  const bal = await circle.getWalletTokenBalance({ id: from.id });
  const token = bal.data?.tokenBalances?.find((t) => t.token?.symbol?.toUpperCase().startsWith("USDC"))?.token;
  if (!token?.id) throw new Error("USDC not found in wallet balances");
  const tx = await circle.createTransaction({
    walletId: from.id,
    tokenId: token.id,
    destinationAddress: to,
    amount: [amount],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  const done = await circle.getTransaction({ id: tx.data!.id!, waitForTxHash: true });
  const hash = done.data?.transaction?.txHash;
  console.log(`sent ${amount} USDC ${fromRef} -> ${to}\nhttps://explorer.testnet.arc.io/tx/${hash}`);
})().catch((e) => {
  console.error("FAILED:", e?.response?.status ?? "", JSON.stringify(e?.response?.data ?? e?.message ?? e));
  process.exit(1);
});
