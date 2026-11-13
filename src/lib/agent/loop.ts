/**
 * Native agent loop on the xAI Responses API, with a persistent per-agent session.
 *
 *  - Same agent  → continues its conversation (previous_response_id chain), like Claude Code.
 *  - New agent   → fresh microVM + empty session.
 *  - Below compactAt (default 150K tokens of context) nothing is trimmed: full history is kept.
 *  - At compactAt → compaction: Grok summarizes the working history; a new chain starts from
 *    [instructions + summary + pinned money ledger + memory index]. Money facts are never summarized away.
 *  - Prompt caching: instructions + tool list are a fixed prefix per agent; prompt_cache_key and the
 *    x-grok-conv-id header route a chain to the same cache; per-run data goes in user messages only.
 *  - Grok's built-in web_search / x_search run server-side alongside our policy-checked function tools.
 *  - Every step is logged (JSONL). Server-only.
 */
import { createRunLogger, type RunLogger } from "../log";
import { rebuildIndex } from "./memory";
import { DEFAULT_COMPACT_AT, loadSession, now, saveSession, shouldCompact, startNewChain, type Session } from "./session";
import { toolByName, xaiTools, type AgentContext } from "./tools";

const XAI = "https://api.x.ai/v1/responses";
const PRICE = { in: 1.25, cachedIn: 0.2, out: 2.5, searchPer1k: 5 }; // rough list prices, USD
const TRANSCRIPT_RESULT_CHARS = 1500; // per tool result kept for summarization

type FnCall = { type: "function_call"; call_id: string; name: string; arguments: string };
type Usage = { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
type XaiResponse = {
  id: string;
  status?: string;
  output?: Array<{ type: string; [k: string]: unknown }>;
  usage?: Usage;
  server_side_tool_usage?: Record<string, number>;
};

class XaiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function callXai(body: Record<string, unknown>, convId: string): Promise<XaiResponse> {
  const res = await fetch(XAI, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.XAI_API_KEY}`,
      "Content-Type": "application/json",
      "x-grok-conv-id": convId,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as XaiResponse & { error?: unknown };
  if (!res.ok) throw new XaiError(res.status, `xAI ${res.status}: ${JSON.stringify(json.error ?? json).slice(0, 400)}`);
  return json;
}

// ───────────── compaction ─────────────

const COMPACT_SYSTEM = [
  "You compress an AI agent's working history so it can continue seamlessly in a fresh context.",
  "Write a structured summary with these sections:",
  "1. Goals and the current task  2. What has been done (key results and numbers)  3. Decisions and why",
  "4. Facts learned (people, vendors, addresses, amounts, IDs)  5. Workspace files and memory notes created or changed (paths/slugs)",
  "6. Open items and the next step  7. Standing instructions and preferences from the user",
  "Keep exact identifiers (addresses, tx hashes, proposal IDs, amounts, paths, slugs). Do not invent anything. Under 1,200 words.",
].join("\n");

function renderTranscript(s: Session): string {
  const lines = s.transcript.map((e) => {
    switch (e.kind) {
      case "summary":
        return `[EARLIER SUMMARY]\n${e.text}`;
      case "user":
        return `USER: ${e.text}`;
      case "assistant":
        return `AGENT: ${e.text}`;
      case "search":
        return `AGENT used ${e.tool}: ${e.query ?? ""}`;
      case "tool":
        return `TOOL ${e.name}(${JSON.stringify(e.args).slice(0, 400)}) -> ${e.result}`;
    }
  });
  const text = lines.join("\n");
  // keep the whole thing unless enormous; then keep the head (earlier summary) and the most recent tail
  return text.length > 600_000 ? `${text.slice(0, 100_000)}\n…[middle omitted]…\n${text.slice(-450_000)}` : text;
}

async function compact(s: Session, model: string, log: RunLogger, reason: string) {
  const before = s.lastContextTokens;
  log.event("compaction_start", { reason, contextTokens: before, threshold: s.compactAt, transcriptEntries: s.transcript.length });
  const resp = await callXai(
    {
      model,
      input: [
        { role: "system", content: COMPACT_SYSTEM },
        { role: "user", content: renderTranscript(s) },
      ],
      store: false,
      max_output_tokens: 4000,
    },
    `cosign-compact-${s.agent}`,
  );
  const summary = (resp.output ?? [])
    .filter((o) => o.type === "message")
    .flatMap((o) => (o.content as { text?: string }[] | undefined) ?? [])
    .map((c) => c.text ?? "")
    .join("")
    .trim();
  if (!summary) throw new Error("compaction returned an empty summary");
  startNewChain(s, summary);
  log.event("compaction_done", { contextTokensBefore: before, summaryChars: summary.length, newChain: s.chainId, usage: resp.usage });
}

function freshChainPreamble(s: Session, memoryIndex: string): string {
  const summary = s.transcript.find((e) => e.kind === "summary");
  const ledger = s.ledger.length
    ? s.ledger.map((l) => `- ${l.t} ${l.tool}: ${JSON.stringify(l.detail)}`).join("\n")
    : "(none yet)";
  return [
    summary ? `## Context summary (your earlier conversation was compacted)\n${summary.text}` : "",
    `## Pinned money ledger (exact, never summarized)\n${ledger}`,
    `## ${memoryIndex.trim()}\n(Use memory_read to open a note.)`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ───────────── the turn loop ─────────────

export async function runAgentTurn(opts: {
  ctx: AgentContext;
  instructions: string; // fixed per agent → cacheable prefix
  prompt: string;
  model?: string;
  maxSteps?: number;
  compactAt?: number;
  quiet?: boolean;
}) {
  const model = opts.model ?? "grok-4.3";
  const maxSteps = opts.maxSteps ?? 16;
  const agent = opts.ctx.agentRef;
  const s = loadSession(agent, opts.compactAt ?? DEFAULT_COMPACT_AT);
  s.runs += 1;
  const log = createRunLogger(
    { agent, kind: "agent-turn", model, prompt: opts.prompt, run: s.runs, chain: s.chainId, contextTokens: s.lastContextTokens, compactAt: s.compactAt, compactions: s.compactions },
    { quiet: opts.quiet },
  );
  const tools = xaiTools(opts.ctx.policy);
  const totals = { in: 0, cached: 0, out: 0, webSearches: 0, xSearches: 0, toolCalls: 0, refusals: 0, compactions: 0 };

  // memory index: shown at the start of a chain, and again whenever it changed
  const idx = rebuildIndex(agent);
  const memoryChanged = idx.hash !== s.memoryIndexHash;
  s.memoryIndexHash = idx.hash;
  s.transcript.push({ kind: "user", text: opts.prompt, t: now() });

  // compact before this run if the carried-over context is already at the threshold
  if (s.lastResponseId && shouldCompact(s)) {
    await compact(s, model, log, "context at threshold before turn");
    totals.compactions++;
  }

  const userTurn = (extra = "") => ({ role: "user", content: `${extra ? `${extra}\n\n---\n` : ""}${opts.prompt}` });
  const freshInput = (extraUser: string) => [
    { role: "system", content: opts.instructions },
    { role: "user", content: freshChainPreamble(s, idx.text) },
    ...(extraUser ? [{ role: "user", content: extraUser }] : []),
  ];

  let previous: string | undefined = s.lastResponseId;
  let input: unknown[] = previous
    ? [userTurn(memoryChanged ? `Your memory index changed:\n${idx.text}` : "")]
    : [...freshInput(""), userTurn()];
  let finalText = "";

  try {
    for (let step = 1; step <= maxSteps; step++) {
      const cacheKey = `cosign-${agent}-${s.chainId}`;
      log.event("model_request", { step, chain: s.chainId, previous_response_id: previous ?? null, inputItems: input.length });
      let resp: XaiResponse;
      try {
        resp = await callXai({ model, input, tools, store: true, prompt_cache_key: cacheKey, ...(previous ? { previous_response_id: previous } : {}) }, cacheKey);
      } catch (e) {
        // stored responses expire (xAI keeps them 30 days): rebuild the chain from our transcript
        if (previous && e instanceof XaiError && (e.status === 404 || e.status === 400) && /response|previous/i.test(e.message)) {
          log.event("chain_lost", { error: e.message });
          await compact(s, model, log, "previous response unavailable");
          totals.compactions++;
          previous = undefined;
          input = [...freshInput(""), userTurn()];
          step--;
          continue;
        }
        throw e;
      }

      const u = resp.usage ?? {};
      totals.in += u.input_tokens ?? 0;
      totals.cached += u.input_tokens_details?.cached_tokens ?? 0;
      totals.out += u.output_tokens ?? 0;
      totals.webSearches += resp.server_side_tool_usage?.web_search_calls ?? 0;
      totals.xSearches += resp.server_side_tool_usage?.x_search_calls ?? 0;
      s.lastResponseId = resp.id;
      s.lastContextTokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
      if (s.awaitingBaseline) {
        s.postCompactionTokens = s.lastContextTokens;
        s.awaitingBaseline = false;
      }

      const calls: FnCall[] = [];
      for (const item of resp.output ?? []) {
        if (item.type === "web_search_call" || item.type === "x_search_call") {
          const a = item.action as { query?: string; sources?: { url: string }[] } | undefined;
          log.event("server_tool", { tool: item.type, query: a?.query, sources: a?.sources?.slice(0, 5).map((x) => x.url) });
          s.transcript.push({ kind: "search", tool: item.type, query: a?.query, t: now() });
        } else if (item.type === "function_call") {
          calls.push(item as unknown as FnCall);
        } else if (item.type === "message") {
          const text = ((item.content as { text?: string }[] | undefined) ?? []).map((c) => c.text ?? "").join("");
          if (text) {
            finalText = text;
            s.transcript.push({ kind: "assistant", text, t: now() });
          }
        }
      }
      log.event("model_response", {
        step,
        responseId: resp.id,
        functionCalls: calls.map((c) => c.name),
        contextTokens: s.lastContextTokens,
        cachedTokens: u.input_tokens_details?.cached_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
      });
      saveSession(s);
      if (!calls.length) break;

      // run our tools (policy first)
      const outputs: { call_id: string; name: string; output: string }[] = [];
      for (const call of calls) {
        totals.toolCalls++;
        let args: Record<string, unknown> = {};
        try {
          args = call.arguments ? JSON.parse(call.arguments) : {};
        } catch {
          /* tool validates */
        }
        const tool = toolByName.get(call.name);
        let output: unknown;
        const t0 = Date.now();
        if (!tool) {
          output = { error: `unknown tool ${call.name}` };
          log.event("tool_error", { tool: call.name, error: "unknown tool" });
        } else if (tool.kind === "sandbox" && !opts.ctx.policy.sandbox) {
          output = { refused: true, reason: "sandbox tools are disabled for this agent" };
          totals.refusals++;
          log.event("policy_refused", { tool: call.name, args, reason: "sandbox disabled" });
        } else {
          const refusal = tool.check?.(opts.ctx, args) ?? null;
          if (refusal) {
            output = { refused: true, reason: refusal };
            totals.refusals++;
            log.event("policy_refused", { tool: call.name, args, reason: refusal });
          } else {
            log.event("tool_call", { tool: call.name, kind: tool.kind, args });
            try {
              output = await tool.run(opts.ctx, args);
              log.event("tool_result", { tool: call.name, durationMs: Date.now() - t0, result: output });
              if (tool.kind === "money") s.ledger.push({ t: now(), tool: call.name, detail: { args, result: output as Record<string, unknown> } });
            } catch (e) {
              output = { error: (e as Error).message };
              log.event("tool_error", { tool: call.name, durationMs: Date.now() - t0, error: (e as Error).message });
            }
          }
        }
        const outStr = JSON.stringify(output);
        outputs.push({ call_id: call.call_id, name: call.name, output: outStr });
        s.transcript.push({ kind: "tool", name: call.name, args, result: outStr.slice(0, TRANSCRIPT_RESULT_CHARS), t: now() });
      }

      if (totals.compactions === 0 && shouldCompact(s)) {
        // compact mid-turn (at most once per turn): fold the pending tool results into the new chain as text
        await compact(s, model, log, "context reached threshold mid-turn");
        totals.compactions++;
        const pending = outputs.map((o) => `- ${o.name}: ${o.output.slice(0, 4000)}`).join("\n");
        previous = undefined;
        input = freshInput(`## Results of the tool calls you just made\n${pending}\n\nContinue the current task:\n${opts.prompt}`);
      } else {
        previous = resp.id;
        input = outputs.map((o) => ({ type: "function_call_output", call_id: o.call_id, output: o.output }));
      }
      saveSession(s);
      if (step === maxSteps) log.event("max_steps", { maxSteps });
    }

    const costUsd =
      ((totals.in - totals.cached) * PRICE.in + totals.cached * PRICE.cachedIn + totals.out * PRICE.out) / 1e6 +
      ((totals.webSearches + totals.xSearches) * PRICE.searchPer1k) / 1000;
    saveSession(s);
    log.event("run_end", { status: "ok", totals, contextTokens: s.lastContextTokens, chain: s.chainId, estCostUsd: Number(costUsd.toFixed(4)), finalText });
    return { runId: log.runId, logFile: log.file, finalText, totals, estCostUsd: costUsd, session: { chain: s.chainId, runs: s.runs, contextTokens: s.lastContextTokens, compactions: s.compactions } };
  } catch (e) {
    saveSession(s);
    log.event("run_end", { status: "error", error: (e as Error).message, totals });
    throw e;
  }
}
