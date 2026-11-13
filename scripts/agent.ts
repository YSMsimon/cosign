/**
 * Talk to a Cosign agent from the terminal and watch every step live: Grok's thinking steps,
 * web/X searches, each tool call with its arguments, each result, policy refusals, and the cost.
 * The agent runs in its own Docker Sandboxes microVM (Docker Desktop must be running).
 *
 *   pnpm agent                     chat with the Clerk (can transact, within its limits)
 *   pnpm agent auditor             chat with the Auditor (read-only: money tools are refused)
 *   pnpm agent clerk "prompt"      run one prompt and exit
 *   pnpm agent clerk --fresh       start that agent over: new microVM, empty conversation and memory
 *
 * In the chat: /help /memory /files [path] /sh <command> /session /log /exit
 * Paid demo APIs (invoice reader, vendor check) need `pnpm dev` running in another terminal.
 * Every run is also written to logs/runs/<date>/<runId>.jsonl (replay: pnpm tsx scripts/show-run.ts latest).
 */
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Address } from "viem";
import { agentInstructions } from "../src/lib/agent/instructions";
import { runAgentTurn } from "../src/lib/agent/loop";
import { rebuildIndex } from "../src/lib/agent/memory";
import { DEFAULT_COMPACT_AT, loadSession } from "../src/lib/agent/session";
import type { AgentPolicy } from "../src/lib/agent/tools";
import { destroySandbox, ensureSandbox, listDir, sandboxExec, sandboxPaths } from "../src/lib/sandbox";

// ───────────── agents you can talk to ─────────────
const LENA = process.env.DEPLOYER_ADDRESS as Address; // demo payee "Lena (contractor)"
const contacts = [{ name: "Lena (contractor)", address: LENA, notes: "Frontend contractor, paid weekly" }];

type Profile = { agentRef: string; name: string; mode: string; role: string; policy: AgentPolicy; files: Record<string, string> };
const policyMd = (p: AgentPolicy, extra: string[]) =>
  ["# Nova Labs payment policy", "- Agents draft; humans cosign. Never claim a payment is done until it is approved.", ...extra,
   `- Per-call API spend cap: $${p.maxPerCallUsd}. Max draft: $${p.maxProposalUsd}. Max petty-cash top-up: $${p.maxTopUpUsd}.`].join("\n") + "\n";

const clerkPolicy: AgentPolicy = { maxPerCallUsd: 0.05, allowedHosts: ["localhost", "x402.quicknode.com"], maxProposalUsd: 5, allowedPayees: [LENA], maxTopUpUsd: 1, sandbox: true };
const auditorPolicy: AgentPolicy = { maxPerCallUsd: 0, allowedHosts: [], maxProposalUsd: 0, allowedPayees: [], maxTopUpUsd: 0, sandbox: true };

const PROFILES: Record<string, Profile> = {
  clerk: {
    agentRef: "agent-ap-clerk",
    name: "Clerk",
    mode: "can transact (within limits; humans cosign)",
    role: "You handle payables: read invoices, check vendors, and draft payments for a human to cosign.",
    policy: clerkPolicy,
    files: {
      "policy.md": policyMd(clerkPolicy, ["- Pay only saved contacts (contacts.json).", "- Always run a vendor check before drafting a payment."]),
      "contacts.json": JSON.stringify(contacts, null, 2),
      "inbox/request.md": "Finance request: process invoice 120 this week.\n",
    },
  },
  auditor: {
    agentRef: "agent-auditor",
    name: "Auditor",
    mode: "read-only (no spending, no drafts, no petty cash)",
    role: "You review the company's finances and report findings. You are read-only: you never spend, draft payments or draw petty cash.",
    policy: auditorPolicy,
    files: {
      "policy.md": policyMd(auditorPolicy, ["- The Auditor is read-only."]),
      "contacts.json": JSON.stringify(contacts, null, 2),
    },
  },
};

// ───────────── terminal output ─────────────
const paint = (code: number) => (s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint(2), red = paint(31), green = paint(32), yellow = paint(33), blue = paint(34), magenta = paint(35), cyan = paint(36), bold = paint(1);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [+${s.length - n} chars]` : s);
const lines = (s: string, max: number, pad = "      ") => {
  const ls = s.replace(/\s+$/, "").split("\n");
  const shown = ls.slice(0, max).map((l) => pad + clip(l, 160));
  if (ls.length > max) shown.push(`${pad}${dim(`… ${ls.length - max} more lines`)}`);
  return shown.join("\n");
};

function showArgs(tool: string, a: Record<string, unknown> = {}): string {
  if (tool === "sandbox_bash") return yellow(`$ ${String(a.command)}`);
  if (tool === "write_file") return `${a.path} ${dim(`(${String(a.content ?? "").length} chars)`)}\n${lines(String(a.content ?? ""), 6)}`;
  if (tool === "memory_write") return `[[${a.slug}]] ${a.title ?? ""} ${dim(`(${String(a.content ?? "").length} chars)`)}`;
  return dim(clip(JSON.stringify(a), 300));
}

function showResult(tool: string, r: unknown): string {
  const o = (r ?? {}) as Record<string, unknown>;
  if (tool === "sandbox_bash") {
    const out = [o.stdout ? lines(String(o.stdout), 15) : "", o.stderr ? red(lines(String(o.stderr), 8)) : ""].filter(Boolean).join("\n");
    return `${dim(`exit ${o.exitCode}`)}${out ? `\n${out}` : ""}`;
  }
  if (tool === "read_file") return `${dim(`${o.path} (${o.totalLines} lines)`)}\n${lines(String(o.content ?? ""), 12)}`;
  if (tool === "list_dir") return "\n" + lines(((o.entries as { name: string; type: string; bytes?: number }[]) ?? []).map((e) => `${e.type === "dir" ? "📁" : "  "} ${e.name}${e.bytes != null ? dim(` ${e.bytes} B`) : ""}`).join("\n") || dim("(empty)"), 20);
  return "\n" + lines(clip(JSON.stringify(r, null, 2), 1500), 25);
}

function onEvent(type: string, d: Record<string, unknown>) {
  switch (type) {
    case "model_request":
      console.log(dim(`  … Grok thinking (step ${d.step})`));
      break;
    case "server_tool": {
      const src = (d.sources as string[] | undefined)?.length ? dim(` (${(d.sources as string[]).length} sources)`) : "";
      console.log(magenta(`  ⌕ ${d.tool === "x_search_call" ? "X search" : "web search"}: ${d.query ?? ""}`) + src);
      break;
    }
    case "tool_call":
      console.log(`${cyan(`  → ${d.tool}`)} ${showArgs(String(d.tool), d.args as Record<string, unknown>)}`);
      break;
    case "tool_result":
      console.log(`${green(`  ← ${d.tool}`)} ${dim(`${d.durationMs} ms`)} ${showResult(String(d.tool), d.result)}`);
      break;
    case "policy_refused":
      console.log(red(`  ✗ ${d.tool} refused by policy: ${d.reason}`) + " " + dim(clip(JSON.stringify(d.args ?? {}), 200)));
      break;
    case "tool_error":
      console.log(red(`  ✗ ${d.tool} failed: ${clip(String(d.error), 400)}`));
      break;
    case "compaction_start":
      console.log(yellow(`  ⟳ compacting context (${d.contextTokens} tokens, threshold ${d.threshold})`));
      break;
    case "compaction_done":
      console.log(yellow(`  ⟳ compacted: ${d.contextTokensBefore} tokens → summary, new chain ${d.newChain}`));
      break;
    case "chain_lost":
    case "max_steps":
      console.log(yellow(`  ! ${type} ${clip(JSON.stringify(d), 200)}`));
      break;
  }
}

// ───────────── main ─────────────
(async () => {
  const args = process.argv.slice(2);
  const fresh = args.includes("--fresh");
  const rest = args.filter((a) => a !== "--fresh");
  const key = rest[0] && PROFILES[rest[0]] ? rest.shift()! : "clerk";
  const oneShot = rest.join(" ").trim();
  const P = PROFILES[key];
  const treasury = JSON.parse(readFileSync("data/treasury.local.json", "utf8")).treasury as Address;

  if (fresh) {
    const p = sandboxPaths(P.agentRef);
    await destroySandbox(P.agentRef).catch(() => {});
    if (existsSync(p.base)) renameSync(p.base, join(process.env.HOME!, ".Trash", `cosign-${P.agentRef}-${Date.now()}`));
    console.log(dim(`started ${P.name} over (old workspace moved to the Trash)`));
  }
  console.log(dim(`starting ${P.name}'s microVM…`));
  const sb = await ensureSandbox(P.agentRef, P.files);
  const instructions = agentInstructions({ name: P.name, company: "Nova Labs", role: P.role, sandbox: sb });
  const ctx = { agentRef: P.agentRef, treasury, policy: P.policy };
  let lastLog = "";

  const sessionLine = () => {
    const s = loadSession(P.agentRef);
    if (!s.runs) return "new conversation (no runs yet)";
    return `runs ${s.runs} · context ${s.lastContextTokens.toLocaleString()} / ${DEFAULT_COMPACT_AT.toLocaleString()} tokens · compactions ${s.compactions} · chain ${s.chainId}`;
  };

  console.log(`\n${bold(P.name)} ${dim(`(${P.agentRef}) · ${P.mode}`)}`);
  console.log(dim(`limits: per API call $${P.policy.maxPerCallUsd} · max draft $${P.policy.maxProposalUsd} · top-up $${P.policy.maxTopUpUsd} · sellers [${P.policy.allowedHosts.join(", ")}] · payees ${P.policy.allowedPayees.length}`));
  console.log(dim(`microVM ${sb.name} · workspace ${sb.workspace} · context (read-only) ${sb.context}`));
  console.log(dim(sessionLine()));

  const turn = async (prompt: string) => {
    const r = await runAgentTurn({ ctx, instructions, prompt, quiet: true, onEvent });
    lastLog = r.logFile;
    const cachedPct = r.totals.in ? Math.round((100 * r.totals.cached) / r.totals.in) : 0;
    console.log(`\n${blue(`${P.name} ›`)} ${r.finalText}\n`);
    console.log(dim(`  ${r.totals.toolCalls} tool calls · ${r.totals.refusals} refused · ${r.totals.webSearches + r.totals.xSearches} searches · in ${r.totals.in.toLocaleString()} tok (${cachedPct}% cached) · out ${r.totals.out.toLocaleString()} · ~$${r.estCostUsd.toFixed(4)}`));
    console.log(dim(`  ${sessionLine()}`));
  };

  if (oneShot) {
    console.log(`\n${bold("you ›")} ${oneShot}`);
    await turn(oneShot);
    return;
  }

  console.log(dim("type a message, or /help\n"));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => { console.log(dim("\nbye")); process.exit(0); });
  for (;;) {
    const line = (await rl.question(bold("you › "))).trim();
    if (!line) continue;
    const [cmd, ...more] = line.split(" ");
    const arg = more.join(" ");
    try {
      if (cmd === "/exit" || cmd === "/quit") break;
      else if (cmd === "/help") {
        console.log(dim("/memory        the agent's memory index (memory/INDEX.md)\n/files [path]  list files in the workspace (or a context path)\n/sh <command>  run a command yourself inside the agent's microVM\n/session       conversation size, runs, compactions\n/log           the JSONL file of the last run\n/exit"));
      } else if (cmd === "/memory") console.log(rebuildIndex(P.agentRef).text || dim("(no notes yet)"));
      else if (cmd === "/files") console.log(showResult("list_dir", listDir(P.agentRef, arg || ".")));
      else if (cmd === "/sh") console.log(showResult("sandbox_bash", await sandboxExec(P.agentRef, arg || "ls -la")));
      else if (cmd === "/session") console.log(dim(sessionLine()));
      else if (cmd === "/log") console.log(lastLog ? `${lastLog}\n${dim("replay: pnpm tsx scripts/show-run.ts latest")}` : dim("no run yet"));
      else if (cmd.startsWith("/")) console.log(dim("unknown command, try /help"));
      else await turn(line);
    } catch (e) {
      console.log(red(`error: ${(e as Error).message}`));
    }
  }
  rl.close();
})().catch((e) => {
  console.error(red(`FAILED: ${e?.message ?? e}`));
  process.exit(1);
});
