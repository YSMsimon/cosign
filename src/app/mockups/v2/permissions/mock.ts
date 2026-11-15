import type { OrbHue } from "@/components/orb-avatar";
import type { Agent } from "../agents";
import { walletOf } from "../money";

/**
 * Mock data for the Permissions page (started as the design board), shaped like the backend's own types (src/lib/agent/rules.ts
 * Abilities/Controls, agentView, onchainStatus, workspaceDetail) so the chosen design can be wired later.
 */
export const usd = (n: number) => (n < 1 ? `$${n.toFixed(2)}` : `$${n % 1 ? n.toFixed(2) : n}`);

export const clerk = {
  name: "Clerk",
  wallet: "0x41c9a7d2e3b8f05c6a1d9e4b7c2f8a3d5e6b8a20",
  walletUsdc: 0.84,
  abilities: { buy: true, draft: true, pettyCash: true },
  controls: {
    purchases: { perPayment: 0.05, daily: 0.5, weekly: 2, monthly: 5 },
    drafts: { perPayment: 5, daily: 20, weekly: 50, monthly: 100 },
    maxPaymentsPerHour: 30,
    allowedSellers: ["x402.quicknode.com", "api.vendorcheck.dev"],
    allowedPayees: [{ name: "Lena (contractor)", address: "0x7797c2a1e5b9d3f8064a2c7e1b5d9f3a8c6ef1e7" }],
    askAboveUsd: 0.05,
    topUpMaxUsd: 1,
    pettyCashPerWeekUsd: 2,
    allowedSwapTokens: ["EURC"] as string[],
    maxSlippageBps: 300,
    frozen: false,
    expiresAt: null as string | null,
  },
  /** not returned by the backend yet: spend so far (agent_spend) */
  usage: { purchasesToday: 0.03, draftsToday: 2.4, paymentsThisHour: 3 },
  onchain: { isProposer: true, pettyCashPerWeekUsd: 2, pettyCashLeftUsd: 1.4, inSync: true },
  you: { canLoosen: true, canTighten: true },
};

/** Every agent always has its own computer (sandbox), so it is not a switch (Simon, 2026-11-14). */
export type AbilityKey = "buy" | "draft" | "pettyCash";
export const ABILITIES: { key: AbilityKey; title: string; text: string }[] = [
  { key: "buy", title: "Spend from its own wallet", text: "Pays per use from its own wallet: APIs, data, compute or other agents." },
  { key: "draft", title: "Ask to pay from the treasury", text: "Asks to pay saved payees from the company treasury. A person always approves." },
  { key: "pettyCash", title: "Refill from the treasury", text: "Tops up its own wallet from the treasury, up to a weekly amount, without asking." },
];

export const treasury = {
  name: "Nova Labs treasury",
  address: "0xb496FD2D5b29A5b12Ee3d30e7359578fec86e62c",
  chain: "Arc testnet",
  balanceUsd: 48.6,
  threshold: 1,
  paused: false,
  approvers: [
    { name: "Simon", initials: "SY", wallet: "0x8f2c5d1e9b7a3c6f0e4d2b8a1c9e7f5d3b2a41aa", you: true },
    { name: "Priya", initials: "PR", wallet: "0x51d044bcff24eb6751fdcc80626affe0ad389c3e", you: false },
  ],
  thisWeek: { apiPurchases: 0.41, pettyCash: 0.6, payments: 2.4 },
  proposals: [
    { id: 5, to: "Lena (contractor)", amount: 2.4, by: "Clerk", approvals: 0, status: "open" as const },
    { id: 4, to: "Vendor check API credits", amount: 3, by: "Clerk", approvals: 1, status: "paid" as const },
    { id: 3, to: "Add Priya as approver", amount: 0, by: "Simon", approvals: 1, status: "done" as const },
    { id: 2, to: "Design contractor", amount: 12, by: "Simon", approvals: 0, status: "cancelled" as const },
  ],
};

/** Everything the Permissions page shows for one agent (mock until wiring: agentView + onchainStatus). */
export type AgentSetup = {
  id: string;
  name: string;
  hue: OrbHue;
  wallet: string;
  walletUsdc: number;
  abilities: Record<AbilityKey, boolean>;
  controls: typeof clerk.controls;
  usage: typeof clerk.usage;
  onchain: typeof clerk.onchain;
  /** has spending to chart (only the sample Clerk does) */
  history: boolean;
};

/** The backend's DEFAULT_CONTROLS (src/lib/agent/rules.ts): what a new agent gets once an ability is turned on. */
const DEFAULT_CONTROLS: typeof clerk.controls = {
  purchases: { perPayment: 0.05, daily: 0.5, weekly: 2, monthly: 5 },
  drafts: { perPayment: 5, daily: 20, weekly: 50, monthly: 100 },
  maxPaymentsPerHour: 10,
  allowedSellers: [],
  allowedPayees: [],
  askAboveUsd: 0.05,
  topUpMaxUsd: 1,
  pettyCashPerWeekUsd: 2,
  allowedSwapTokens: [],
  maxSlippageBps: 300,
  frozen: false,
  expiresAt: null,
};

export function setupFor(agent: Agent): AgentSetup {
  if (agent.id === "clerk") return { ...clerk, id: agent.id, name: agent.name, hue: agent.hue, history: true };
  const w = walletOf(agent.id);
  return {
    id: agent.id,
    name: agent.name,
    hue: agent.hue,
    wallet: w.address,
    walletUsdc: w.usdc,
    abilities: { buy: false, draft: false, pettyCash: false }, // a new agent starts with no money (sample Auditor and Scribe too)
    controls: DEFAULT_CONTROLS,
    usage: { purchasesToday: 0, draftsToday: 0, paymentsThisHour: 0 },
    onchain: { isProposer: false, pettyCashPerWeekUsd: 0, pettyCashLeftUsd: 0, inSync: true },
    history: false,
  };
}

export const hasMoney = (ab: Record<AbilityKey, boolean>) => ab.buy || ab.draft || ab.pettyCash;
