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
import { createHash } from "node:crypto";
import { createRunLogger, type RunEventHandler, type RunLogger } from "../log";
import { rebuildIndex } from "./memory";
import { DEFAULT_COMPACT_AT, loadSession, now, saveSession, shouldCompact, startNewChain, type Session } from "./session";
import { runToolChecked, takeSayFirst, toolByName, xaiTools, type AgentContext } from "./tools";

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

/** A Grok call gives up when nothing arrives for this long (streamed) or it takes this long in all (not streamed). */
const STALL_MS = 60_000;
const WHOLE_MS = 150_000;

/**
 * One model call. With `onText`, the call is streamed: each piece of the answer's text goes to `onText` as Grok writes
 * it, and the finished response (from `response.completed`) is returned, the same object as without streaming.
 * A call that hangs (seen 2026-11-15: no answer for over a minute after a tool) is tried once more if nothing was said
 * yet, else it fails with a plain error instead of leaving the turn hanging.
 */
async function callXai(body: Record<string, unknown>, convId: string, onText?: (text: string) => void): Promise<XaiResponse> {
  for (let attempt = 0; ; attempt++) {
    let said = false;
    try {
      return await callXaiOnce(body, convId, onText && ((t) => ((said = true), onText(t))));
    } catch (e) {
      if (e instanceof XaiError && e.status === 504 && attempt === 0 && !said) continue;
      throw e;
    }
  }
}

async function callXaiOnce(body: Record<string, unknown>, convId: string, onText?: (text: string) => void): Promise<XaiResponse> {
  const ctl = new AbortController();
  const limit = onText ? STALL_MS : WHOLE_MS;
  let timer = setTimeout(() => ctl.abort(), limit);
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctl.abort(), limit);
  };
  try {
    const res = await fetch(XAI, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
        "Content-Type": "application/json",
        "x-grok-conv-id": convId,
      },
      body: JSON.stringify(onText ? { ...body, stream: true } : body),
      signal: ctl.signal,
    });
    if (!onText || !res.ok || !res.body) {
      const json = (await res.json().catch(() => ({}))) as XaiResponse & { error?: unknown };
      if (!res.ok) throw new XaiError(res.status, `xAI ${res.status}: ${JSON.stringify(json.error ?? json).slice(0, 400)}`);
      return json;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      touch();
      buf += dec.decode(value, { stream: true });
      let cut: number;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const data = /^data: (.+)$/m.exec(chunk)?.[1];
        if (!data || data === "[DONE]") continue;
        let ev: { type?: string; delta?: string; response?: XaiResponse & { error?: unknown }; error?: unknown };
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        if (ev.type === "response.output_text.delta" && ev.delta) onText(ev.delta);
        else if (ev.type === "response.completed" && ev.response) return ev.response;
        else if (ev.type === "response.failed" || ev.type === "response.incomplete" || ev.type === "error") {
          throw new XaiError(502, `xAI stream ${ev.type}: ${JSON.stringify(ev.response?.error ?? ev.error ?? ev).slice(0, 400)}`);
        }
      }
    }
    throw new XaiError(502, "xAI stream ended before the response was complete");
  } catch (e) {
    if (ctl.signal.aborted) throw new XaiError(504, `Grok didn't answer for ${limit / 1000} s; try again`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
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
  onEvent?: RunEventHandler; // live tool calls / results for a terminal or UI
  thread?: string; // separate conversation (per person on a team agent, per schedule); memory stays shared
  turnNote?: string; // sent to the model with this prompt only (e.g. "this was spoken"), not stored in the transcript
  via?: "voice"; // how this turn reached us, kept on its transcript entries
  stream?: boolean; // send the answer's text to onEvent as it is written ("text_delta"), not only at the end
}) {
  // grok-4.20 reasoning (Simon, 2026-11-15): grok-4.3 stalled for 66 s and 122 s on single calls; this one stayed at
  // 1.4–2.6 s on the same conversation and still checks with its tools. AGENT_MODEL overrides it.
  const model = opts.model ?? (process.env.AGENT_MODEL || "grok-4.20-0309-reasoning");
  const maxSteps = opts.maxSteps ?? 16;
  const agent = opts.ctx.agentRef;
  const s = loadSession(agent, opts.compactAt ?? DEFAULT_COMPACT_AT, opts.thread);
  s.runs += 1;
  const log = createRunLogger(
    { agent, thread: opts.thread ?? null, scope: opts.ctx.scope ?? null, kind: "agent-turn", model, prompt: opts.prompt, run: s.runs, chain: s.chainId, contextTokens: s.lastContextTokens, compactAt: s.compactAt, compactions: s.compactions },
    { quiet: opts.quiet, onEvent: opts.onEvent },
  );
  const tools = xaiTools(opts.ctx, { sayFirst: opts.via === "voice" }); // voice: each call carries a sentence to say first
  // streamed text goes straight to the live view; the run log keeps only the whole reply (model_response, run_end)
  const turnStart = Date.now();
  const onText = opts.stream && opts.onEvent ? (text: string) => opts.onEvent!("text_delta", { text }, Date.now() - turnStart) : undefined;
  const totals = { in: 0, cached: 0, out: 0, webSearches: 0, xSearches: 0, toolCalls: 0, refusals: 0, compactions: 0 };

  // memory index: shown at the start of a chain, and again whenever it changed
  const idx = rebuildIndex(agent);
  const memoryChanged = idx.hash !== s.memoryIndexHash;
  s.memoryIndexHash = idx.hash;
  s.transcript.push({ kind: "user", text: opts.prompt, t: now(), ...(opts.via ? { via: opts.via } : {}) });

  // compact before this run if the carried-over context is already at the threshold
  if (s.lastResponseId && shouldCompact(s)) {
    await compact(s, model, log, "context at threshold before turn");
    totals.compactions++;
  }

  const userTurn = (extra = "") => {
    const pre = [extra, opts.turnNote].filter(Boolean).join("\n\n");
    return { role: "user", content: `${pre ? `${pre}\n\n---\n` : ""}${opts.prompt}` };
  };
  const freshInput = (extraUser: string) => [
    { role: "system", content: opts.instructions },
    { role: "user", content: freshChainPreamble(s, idx.text) },
    ...(extraUser ? [{ role: "user", content: extraUser }] : []),
  ];

  // the system instructions go out at the start of a chain; if they changed since, send them again once
  const instructionsHash = createHash("sha256").update(opts.instructions).digest("hex").slice(0, 16);
  let previous: string | undefined = s.lastResponseId;
  const updated = previous && s.instructionsHash !== instructionsHash ? [{ role: "system", content: `Your instructions were updated. They replace the earlier ones:\n\n${opts.instructions}` }] : [];
  let input: unknown[] = previous
    ? [...updated, userTurn(memoryChanged ? `Your memory index changed:\n${idx.text}` : "")]
    : [...freshInput(""), userTurn()];
  let finalText = "";
  let nudged = false; // asked once for an answer after an empty reply

  try {
    const calledTimes = new Map<string, number>(); // name + arguments → runs this turn
    for (let step = 1; step <= maxSteps; step++) {
      const cacheKey = `cosign-${agent}-${s.chainId}`;
      log.event("model_request", { step, chain: s.chainId, previous_response_id: previous ?? null, inputItems: input.length });
      let resp: XaiResponse;
      try {
        resp = await callXai({ model, input, tools, store: true, prompt_cache_key: cacheKey, ...(previous ? { previous_response_id: previous } : {}) }, cacheKey, onText);
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
      s.instructionsHash = instructionsHash;
      s.lastContextTokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
      if (s.awaitingBaseline) {
        s.postCompactionTokens = s.lastContextTokens;
        s.awaitingBaseline = false;
      }

      const calls: FnCall[] = [];
      let saidSomething = false;
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
            saidSomething = true;
            finalText = text;
            s.transcript.push({ kind: "assistant", text, t: now(), ...(opts.via ? { via: opts.via } : {}) });
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
      if (!calls.length) {
        // Grok sometimes ends a turn with no text at all (seen after a tool call): ask once for the answer
        if (!saidSomething && !nudged && step < maxSteps) {
          nudged = true;
          log.event("empty_reply", { step });
          previous = resp.id;
          input = [{ role: "user", content: "(Cosign: your last reply was empty. Answer the person now, using what you already found.)" }];
          continue;
        }
        break;
      }

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
        const t0 = Date.now();
        const tool = toolByName.get(call.name);
        const sayFirst = takeSayFirst(args); // spoken by the voice before the tool runs; never passed to the tool
        log.event("tool_call", { tool: call.name, kind: tool?.kind, args, ...(sayFirst ? { sayFirst } : {}) });
        // the same lookup over and over (seen 2026-11-15: a frozen agent called list_allowed 16 times and never answered)
        const sig = `${call.name}:${JSON.stringify(args)}`;
        calledTimes.set(sig, (calledTimes.get(sig) ?? 0) + 1);
        const res =
          (calledTimes.get(sig) ?? 0) > 2
            ? ({ status: "error", error: "already ran twice with the same arguments this turn", output: { error: "You already ran this with the same arguments in this turn. Don't run it again: answer the person now with what you have." } } as Awaited<ReturnType<typeof runToolChecked>>)
            : await runToolChecked(opts.ctx, call.name, args);
        const output = res.output;
        if (res.status === "refused") {
          totals.refusals++;
          log.event("policy_refused", { tool: call.name, args, reason: res.reason });
        } else if (res.status === "error") {
          log.event("tool_error", { tool: call.name, durationMs: Date.now() - t0, error: res.error });
        } else {
          log.event("tool_result", { tool: call.name, durationMs: Date.now() - t0, result: output });
          if (res.kind === "money") s.ledger.push({ t: now(), tool: call.name, detail: { args, result: output as Record<string, unknown> } });
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

    // out of steps with nothing said: one last call, no tools, for the answer (the person always gets one)
    if (!finalText && previous) {
      const resp = await callXai(
        { model, input: [...input, { role: "user", content: "(Cosign: you're out of steps for this turn. Answer the person now with what you found; no more tools.)" }], tools, tool_choice: "none", store: true, previous_response_id: previous, prompt_cache_key: `cosign-${agent}-${s.chainId}` },
        `cosign-${agent}-${s.chainId}`,
        onText,
      );
      const text = (resp.output ?? []).filter((o) => o.type === "message").flatMap((o) => (o.content as { text?: string }[] | undefined) ?? []).map((c) => c.text ?? "").join("");
      s.lastResponseId = resp.id;
      if (text) {
        finalText = text;
        s.transcript.push({ kind: "assistant", text, t: now(), ...(opts.via ? { via: opts.via } : {}) });
      }
      log.event("final_answer", { reason: "out of steps", chars: text.length });
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
