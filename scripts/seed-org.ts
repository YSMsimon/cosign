/**
 * Set up the demo company for the video: a new treasury from the factory with the owner's wallet as its only
 * approver (threshold 1), its workspace with the owner as All access, three saved contacts, and two team agents:
 * Payables (paid APIs + drafting, payees Oliver Grant and Northpine) and Controller (read-only). Payables' wallet
 * gets a little USDC from the deployer wallet for gas and its Gateway balance.
 *
 * Safe to re-run: every step checks what is already there (state in data/demo-org.local.json; the payees' throwaway
 * keys in data/payees.local.json, both git-ignored, so money paid to them in the demo can be recovered).
 *
 *   pnpm tsx --env-file=.env.local scripts/seed-org.ts
 *   sh node_modules/.cosign-tmp/walcheck.sh
 *
 * Left to the owner's wallet (the only approver): depositing into the treasury, and letting Payables draft and draw
 * petty cash onchain (Permissions → Payables → sign in your wallet).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { createWalletClient, erc20Abi, getAddress, http, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arcTestnet, callFrom, chain, explorerAddr, explorerTx, fmt, RECEIPT_POLL_MS, USDC, usdcBalance } from "../src/lib/arc";
import { treasuryFactoryAbi, TREASURY_FACTORY_ADDRESS } from "../src/lib/contracts/abis";
import { db, schema } from "../src/lib/db";
import { loadMembership } from "../src/lib/server/access";
import { createAgent } from "../src/lib/server/agents";
import { addContact, createWorkspace } from "../src/lib/server/workspaces";

const NAME = process.env.DEMO_COMPANY ?? "Simon's Org";
const CREATOR_REF = "test-cfo"; // only pays the gas for createTreasury; it is not an approver of the new treasury
const STATE = "data/demo-org.local.json";
const PAYEES = "data/payees.local.json";
const PAYABLES_FUNDING_USD = "1.5"; // gas + the Gateway balance its paid calls spend
const DEMO_SELLERS = ["localhost:3000/api/sellers", "x402.quicknode.com"];

const CONTACTS = [
  { name: "Oliver Grant", notes: "Contractor, frontend work. Invoices weekly." },
  { name: "Northpine Hosting Inc.", notes: "Hosting for the app. Invoices monthly." },
  { name: "Pixel Studio", notes: "Design studio: logo and brand kit." },
];

type State = { treasury?: string; workspaceId?: string; createTx?: string };
type Payee = { name: string; address: string; privateKey: string };

const readJson = <T>(p: string, fallback: T): T => (existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback);
const save = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 2) + "\n");

(async () => {
  const owner = process.env.COSIGN_OWNER_ADDRESS?.toLowerCase();
  if (!owner) throw new Error("set COSIGN_OWNER_ADDRESS (your wallet) in .env.local");
  const state = readJson<State>(STATE, {});

  // 1. the treasury, onchain: the owner is its only approver; the agents are added later from the owner's wallet
  if (!state.treasury && !state.createTx) {
    const { hash } = await callFrom(CREATOR_REF, TREASURY_FACTORY_ADDRESS, treasuryFactoryAbi, "createTreasury", [NAME, [getAddress(owner)], [], 1]);
    state.createTx = hash;
    save(state); // before anything else can fail: a re-run must not create a second treasury
    console.log(`1. created the treasury "${NAME}": ${explorerTx(hash)}`);
  } else console.log(`1. treasury already created (${state.treasury ?? state.createTx})`);

  // 2. its workspace (registers the treasury with the QuickNode watch list too)
  let ws = state.treasury ? db().select().from(schema.workspaces).where(eq(schema.workspaces.treasury, state.treasury)).get() : undefined;
  if (!ws) {
    ws = await createWorkspace(owner, { name: NAME, txHash: state.createTx, title: "Founder" });
    state.treasury = ws.treasury;
    state.workspaceId = ws.id;
    save(state);
    console.log(`2. workspace "${NAME}" (${ws.id}), you = All access`);
  } else console.log(`2. workspace exists: ${ws.name} (${ws.id})`);
  const m = loadMembership(owner, ws.id);
  if (!m) throw new Error("you are not a member of the new workspace");

  // 3. saved contacts, each with a throwaway wallet whose key stays local
  const payees = readJson<Payee[]>(PAYEES, []);
  for (const c of CONTACTS) {
    if (!payees.find((p) => p.name === c.name)) {
      const key = generatePrivateKey();
      payees.push({ name: c.name, address: privateKeyToAccount(key).address.toLowerCase(), privateKey: key });
      writeFileSync(PAYEES, JSON.stringify(payees, null, 2) + "\n");
    }
  }
  const addr = (name: string) => payees.find((p) => p.name === name)!.address;
  for (const c of CONTACTS) {
    const a = addr(c.name);
    const has = db().select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, ws.id), eq(schema.contacts.address, a))).get();
    if (!has) addContact(m, { name: c.name, address: a, notes: c.notes });
  }
  console.log(`3. saved contacts: ${CONTACTS.map((c) => `${c.name} ${addr(c.name).slice(0, 6)}…${addr(c.name).slice(-4)}`).join(", ")}`);

  // 4. the agents, made the way the app makes them (a Circle wallet each)
  const agentNamed = (name: string) => db().select().from(schema.agents).where(and(eq(schema.agents.workspaceId, ws.id), eq(schema.agents.name, name))).get();
  const payables =
    agentNamed("Payables") ??
    (await createAgent(m, {
      name: "Payables",
      prompt: "You pay the company's bills: read invoices, check vendors, and draft payments for a person to cosign.",
      visibility: "team",
      preset: "clerk",
      hue: "blue",
      controls: {
        purchases: { perPayment: 0.05, daily: 2, weekly: 5, monthly: 10 },
        maxPaymentsPerHour: 30,
        allowedSellers: DEMO_SELLERS,
        allowedPayees: [addr("Oliver Grant"), addr("Northpine Hosting Inc.")], // Pixel Studio stays off, for the refusal
        pettyCashPerWeekUsd: 2,
      },
    }));
  const controller =
    agentNamed("Controller") ??
    (await createAgent(m, {
      name: "Controller",
      prompt: "You review the company's payments and report what you find. You never spend, draft or draw petty cash.",
      visibility: "team",
      preset: "readonly",
      hue: "teal",
    }));
  console.log(`4. agents: Payables (${payables.walletAddress}), Controller (${controller.walletAddress})`);

  // 5. a little USDC in Payables' own wallet, from the deployer (gas + its Gateway balance)
  const have = await usdcBalance(payables.walletAddress as Address);
  if (have < parseUnits("1", 6)) {
    const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex);
    const client = createWalletClient({ account: deployer, chain: arcTestnet, transport: http() });
    const hash = await client.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [payables.walletAddress as Address, parseUnits(PAYABLES_FUNDING_USD, 6)] });
    await chain.waitForTransactionReceipt({ hash, pollingInterval: RECEIPT_POLL_MS });
    console.log(`5. sent Payables $${PAYABLES_FUNDING_USD} from the deployer: ${explorerTx(hash)}`);
  } else console.log(`5. Payables already holds $${fmt(have)}`);

  console.log(`
treasury: ${ws.treasury}
  ${explorerAddr(ws.treasury)}
workspace: ${ws.id}

Next, from your wallet:
  1. send ~10 USDC to the treasury address above (Arc testnet)
  2. in the browser console on localhost:3000:  localStorage.setItem("cosign-ws", "${ws.id}"); location.reload()
  3. Permissions → Payables → sign in your wallet (lets it draft; $2/week petty cash)`);
  process.exit(0);
})().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  process.exit(1);
});
