/**
 * Session + memory + compaction test with a brand-new agent ("agent-scribe"):
 *  A. new agent -> fresh microVM + empty session; it stores facts as linked memory notes
 *  B. same agent, next run -> continues its context (no re-explaining)
 *  C. forced low threshold -> compaction; a new chain starts from the summary
 *  D. after compaction -> still recalls the facts (summary + memory graph)
 * Needs Docker Desktop. Money tools are disabled by policy for this agent.
 * Run: pnpm tsx --env-file=.env.local scripts/07-agent-session-demo.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import { agentInstructions } from "../src/lib/agent/instructions";
import { runAgentTurn } from "../src/lib/agent/loop";
import type { AgentPolicy } from "../src/lib/agent/tools";
import { destroySandbox, ensureSandbox, sandboxPaths } from "../src/lib/sandbox";

const AGENT = "agent-scribe";
const policy: AgentPolicy = { maxPerCallUsd: 0, allowedHosts: [], maxProposalUsd: 0, allowedPayees: [], maxTopUpUsd: 0, sandbox: true };
const treasury = JSON.parse(readFileSync("data/treasury.local.json", "utf8")).treasury as Address;

(async () => {
  // start from a genuinely fresh agent for the test
  const p = sandboxPaths(AGENT);
  await destroySandbox(AGENT).catch(() => {});
  if (existsSync(p.base)) {
    const { renameSync } = await import("node:fs");
    renameSync(p.base, join(process.env.HOME!, ".Trash", `cosign-${AGENT}-${Date.now()}`));
  }
  const sb = await ensureSandbox(AGENT, { "policy.md": "# Nova Labs\n- Scribe keeps company notes. No payments.\n" });
  const instructions = agentInstructions({ name: "Scribe", company: "Nova Labs", role: "You keep the team's operating notes.", sandbox: sb });
  const ctx = { agentRef: AGENT, treasury, policy };

  const turn = async (label: string, prompt: string, compactAt?: number) => {
    const r = await runAgentTurn({ ctx, instructions, prompt, compactAt, quiet: true });
    console.log(
      `\n[${label}] chain=${r.session.chain} run=${r.session.runs} context=${r.session.contextTokens} tok, compactions=${r.session.compactions}, ` +
        `this turn: in ${r.totals.in} (cached ${r.totals.cached}) out ${r.totals.out}, tools ${r.totals.toolCalls}, ~$${r.estCostUsd.toFixed(4)}\n  > ${r.finalText.replace(/\n+/g, " ").slice(0, 400)}`,
    );
    return r;
  };

  await turn("A new agent", "Remember two facts as separate linked memory notes: our CFO is Sam Park, and Sam wants payment batches approved every Friday at 4pm. Link them. Reply in one sentence.");
  await turn("B same agent", "What did I ask you to remember, and which memory note slugs did you create? One sentence.");
  await turn("C compaction", "Also remember that Lena (contractor) is paid 2.40 USDC weekly in the Friday batch; link it to the existing notes. One sentence.", 2_000);
  await turn("D after compaction", "Without using any tools: who is our CFO, when are batches approved, and how much is Lena paid?");

  const idx = readFileSync(join(sb.workspace, "memory", "INDEX.md"), "utf8");
  console.log(`\nmemory/INDEX.md:\n${idx}`);
  const s = JSON.parse(readFileSync(join(p.base, "session.json"), "utf8"));
  console.log(`session.json: runs=${s.runs} compactions=${s.compactions} chain=${s.chainId} transcriptEntries=${s.transcript.length} (first: ${s.transcript[0]?.kind})`);
})().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  process.exit(1);
});
