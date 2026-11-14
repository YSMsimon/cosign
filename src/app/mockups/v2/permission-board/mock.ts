/**
 * Mock data for the permissions design board, shaped like the backend's own types (src/lib/agent/rules.ts
 * Abilities/Controls, agentView, onchainStatus, workspaceDetail) so the chosen design can be wired later.
 */
export const usd = (n: number) => (n < 1 ? `$${n.toFixed(2)}` : `$${n % 1 ? n.toFixed(2) : n}`);

export const clerk = {
  name: "Clerk",
  wallet: "0x41c9a7d2e3b8f05c6a1d9e4b7c2f8a3d5e6b8a20",
  walletUsdc: 0.84,
  abilities: { sandbox: true, buy: true, draft: true, pettyCash: true },
  controls: {
    purchases: { perPayment: 0.05, daily: 0.5, weekly: 2, monthly: 5 },
    drafts: { perPayment: 5, daily: 20, weekly: 50, monthly: 100 },
    maxPaymentsPerHour: 30,
    allowedSellers: ["x402.quicknode.com", "api.vendorcheck.dev"],
    allowedPayees: [{ name: "Lena (contractor)", address: "0x7797c2a1e5b9d3f8064a2c7e1b5d9f3a8c6ef1e7" }],
    askAboveUsd: 0.05,
    topUpMaxUsd: 1,
    pettyCashPerWeekUsd: 2,
    frozen: false,
    expiresAt: null as string | null,
  },
  /** not returned by the backend yet: spend so far (agent_spend) */
  usage: { purchasesToday: 0.03, draftsToday: 2.4, paymentsThisHour: 3 },
  onchain: { isProposer: true, pettyCashPerWeekUsd: 2, pettyCashLeftUsd: 1.4, inSync: true },
  you: { canLoosen: true, canTighten: true },
};

export const ABILITIES = [
  { key: "sandbox", title: "Its own computer", text: "Files and scripts in a sandbox. No secrets inside.", on: true },
  { key: "buy", title: "Pay for APIs", text: "Small purchases from its own wallet (nanopayments).", on: true },
  { key: "draft", title: "Draft treasury payments", text: "Proposes onchain; a person always approves.", on: true },
  { key: "pettyCash", title: "Petty cash", text: "Draws from the treasury within a weekly allowance.", on: true },
] as const;

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
