/**
 * One throwaway company for the browser specs, made the way a real one is: a throwaway owner wallet (funded with a
 * little testnet USDC from the demo CFO) creates the treasury onchain, registers the workspace, saves Lena as a payee,
 * makes a team agent "Clerk" that may draft to her, and signs what its settings need onchain. Reused across runs while
 * it still answers (FRESH=1 makes a new one). Cost of a fresh one: about 0.5 testnet USDC.
 */
import { generatePrivateKey } from "viem/accounts";
import { api, fund, send, signIn, type PreparedTx } from "../e2e/helpers";
import { personFromKey, readState, writeState, type State } from "./shared";
import { ensureQuestion, ensureVoice } from "./voice-setup";

/** The agent's own wallet pays its sends and its network fees (USDC is Arc's gas): keep a little in it. */
async function topUp(wallet: string, usdc: number) {
  if (usdc >= 0.08) return;
  await fund(wallet, "0.1");
  console.log(`[browser] topped up the agent's wallet (${usdc} → +0.1 USDC)`);
}

/** The voice spec's agent on ElevenLabs and its spoken question (only when the voice spec is in the run). */
async function voice(agentId: string) {
  if (process.argv.some((a) => a.includes("spec") && !a.includes("06-voice"))) return;
  ensureQuestion();
  console.log(`[browser] ${await ensureVoice(agentId)}`);
}

export default async function globalSetup() {
  if (!process.env.FRESH) {
    try {
      const s = readState();
      const owner = personFromKey("owner", s.ownerKey);
      await signIn(owner);
      const r = await api(owner, "GET", `/workspaces/${s.ws}`);
      const a = await api(owner, "GET", `/agents/${s.agent}`);
      if (r.status === 200 && a.status === 200 && a.json.agent.status === "active") {
        console.log(`[browser] reusing workspace ${s.ws} (made ${s.createdAt}); FRESH=1 makes a new one`);
        await topUp(a.json.agent.wallet, Number(a.json.agent.balances.walletUsdc));
        // back-to-back runs make many payments: a test agent may make 60 an hour (the default is 10)
        if ((a.json.agent.controls.maxPaymentsPerHour ?? 0) < 60) await api(owner, "PATCH", `/agents/${s.agent}`, { controls: { maxPaymentsPerHour: 60 } });
        // ...and spend more in a day than the default $0.50 (per payment stays $0.05), so a day of runs doesn't hit it
        const p = a.json.agent.controls.purchases;
        if ((p.daily ?? 0) < 5) await api(owner, "PATCH", `/agents/${s.agent}`, { controls: { purchases: { ...p, daily: 5, weekly: 10, monthly: 20 } } });
        await voice(s.agent);
        return;
      }
    } catch {
      /* no usable workspace: make one */
    }
  }

  const ownerKey = generatePrivateKey();
  const owner = personFromKey("owner", ownerKey);
  const lena = (process.env.DEPLOYER_ADDRESS as string).toLowerCase();
  await signIn(owner);
  await fund(owner.address, "0.4");

  const prep = await api(owner, "POST", "/workspaces/prepare", { name: `Browser Co ${Date.now()}` });
  if (prep.status !== 200) throw new Error(`prepare: ${prep.status} ${JSON.stringify(prep.json)}`);
  const txHash = await send(owner, prep.json.tx as PreparedTx);
  const created = await api(owner, "POST", "/workspaces", { name: "Browser Co", txHash, title: "Founder" });
  if (created.status !== 201) throw new Error(`register: ${created.status} ${JSON.stringify(created.json)}`);
  const ws = created.json.workspace.id as string;
  const treasury = created.json.workspace.treasury as string;

  await api(owner, "POST", `/workspaces/${ws}/contacts`, { name: "Lena (contractor)", address: lena, notes: "Frontend contractor" });
  const agent = await api(owner, "POST", `/workspaces/${ws}/agents`, {
    name: "Clerk",
    prompt: "Pays vendor invoices. Drafts treasury payments to saved payees for a person to approve.",
    visibility: "team",
    preset: "clerk",
    hue: "blue",
    controls: { allowedPayees: [lena], drafts: { perPayment: 1, daily: 5, weekly: 10, monthly: 20 }, askAboveUsd: 0.01, maxPaymentsPerHour: 60 },
  });
  if (agent.status !== 201) throw new Error(`agent: ${agent.status} ${JSON.stringify(agent.json)}`);
  const agentId = agent.json.agent.id as string;

  // what the Clerk's settings need onchain (may draft; network fees), signed by the owner's wallet
  const onchain = await api(owner, "GET", `/agents/${agentId}/onchain`);
  for (const tx of (onchain.json.toSign ?? []) as PreparedTx[]) await send(owner, tx);
  // a little money in the treasury, so an approved payment can go out; and in the agent's wallet, for its fees
  await fund(treasury, "0.2");
  await topUp(agent.json.agent.wallet, 0);

  const s: State = { ownerKey, ws, treasury, agent: agentId, agentName: "Clerk", lena, createdAt: new Date().toISOString() };
  writeState(s);
  console.log(`[browser] made workspace ${ws} (treasury ${treasury})`);
  await voice(agentId);
}
