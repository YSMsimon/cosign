/**
 * One throwaway company for the browser specs, made the way a real one is: a throwaway owner wallet (funded with a
 * little testnet USDC from the demo CFO) creates the treasury onchain, registers the workspace, saves Lena as a payee,
 * makes a team agent "Clerk" that may draft to her, and signs what its settings need onchain. Reused across runs while
 * it still answers (FRESH=1 makes a new one). Cost of a fresh one: about 0.5 testnet USDC.
 */
import { generatePrivateKey } from "viem/accounts";
import { api, fund, send, signIn, type PreparedTx } from "../e2e/helpers";
import { personFromKey, readState, writeState, type State } from "./shared";

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
    controls: { allowedPayees: [lena], drafts: { perPayment: 1, daily: 5, weekly: 10, monthly: 20 }, askAboveUsd: 0.01 },
  });
  if (agent.status !== 201) throw new Error(`agent: ${agent.status} ${JSON.stringify(agent.json)}`);
  const agentId = agent.json.agent.id as string;

  // what the Clerk's settings need onchain (may draft; network fees), signed by the owner's wallet
  const onchain = await api(owner, "GET", `/agents/${agentId}/onchain`);
  for (const tx of (onchain.json.toSign ?? []) as PreparedTx[]) await send(owner, tx);
  // a little money in the treasury, so an approved payment can go out
  await fund(treasury, "0.2");

  const s: State = { ownerKey, ws, treasury, agent: agentId, agentName: "Clerk", lena, createdAt: new Date().toISOString() };
  writeState(s);
  console.log(`[browser] made workspace ${ws} (treasury ${treasury})`);
}
