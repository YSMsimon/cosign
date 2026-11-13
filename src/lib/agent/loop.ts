/**
 * Native agent loop on the xAI Responses API (no framework):
 *   request(model, tools = Grok built-ins + our functions)
 *   → Grok may run web_search / x_search itself (server-side)
 *   → if it returns function_call items: policy check → run our tool → send function_call_output
 *   → repeat until it answers with plain text (or maxSteps).
 * Every step is logged (JSONL) for debugging.
 * Server-only.
 */
import { createRunLogger } from "../log";
import { toolByName, xaiTools, type AgentContext } from "./tools";

const XAI = "https://api.x.ai/v1/responses";
// rough list prices for the cost estimate in logs (USD per 1M tokens / per 1k searches)
const PRICE = { in: 1.25, out: 2.5, searchPer1k: 5 };

type OutputItem =
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "web_search_call"; action?: { query?: string; sources?: { url: string }[] } }
  | { type: "x_search_call"; action?: { query?: string } }
  | { type: "message"; content?: { type: string; text?: string }[] }
  | { type: string; [k: string]: unknown };

type XaiResponse = {
  id: string;
  status?: string;
  output?: OutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number };
  server_side_tool_usage?: Record<string, number>;
  error?: unknown;
};

async function callXai(body: Record<string, unknown>): Promise<XaiResponse> {
  const res = await fetch(XAI, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as XaiResponse & { error?: { message?: string } | string };
  if (!res.ok) throw new Error(`xAI ${res.status}: ${typeof json.error === "string" ? json.error : JSON.stringify(json.error ?? json)}`);
  return json;
}

export async function runAgent(opts: {
  ctx: AgentContext;
  instructions: string;
  prompt: string;
  model?: string;
  maxSteps?: number;
  quiet?: boolean;
}) {
  const model = opts.model ?? "grok-4.3";
  const maxSteps = opts.maxSteps ?? 12;
  const log = createRunLogger({ agent: opts.ctx.agentRef, kind: "native-xai-loop", model, prompt: opts.prompt, policy: opts.ctx.policy }, { quiet: opts.quiet });
  const tools = xaiTools(opts.ctx.policy);
  const totals = { in: 0, out: 0, webSearches: 0, xSearches: 0, toolCalls: 0, refusals: 0 };

  let input: unknown[] = [
    { role: "system", content: opts.instructions },
    { role: "user", content: opts.prompt },
  ];
  let previous: string | undefined;
  let finalText = "";

  try {
    for (let step = 1; step <= maxSteps; step++) {
      log.event("model_request", { step, previous_response_id: previous ?? null, inputItems: input.length });
      const resp = await callXai({ model, input, tools, store: true, ...(previous ? { previous_response_id: previous } : {}) });
      totals.in += resp.usage?.input_tokens ?? 0;
      totals.out += resp.usage?.output_tokens ?? 0;
      totals.webSearches += resp.server_side_tool_usage?.web_search_calls ?? 0;
      totals.xSearches += resp.server_side_tool_usage?.x_search_calls ?? 0;

      const calls: Extract<OutputItem, { type: "function_call" }>[] = [];
      for (const item of resp.output ?? []) {
        if (item.type === "web_search_call" || item.type === "x_search_call") {
          const a = (item as { action?: { query?: string; sources?: { url: string }[] } }).action;
          log.event("server_tool", { tool: item.type, query: a?.query, sources: a?.sources?.slice(0, 5).map((s) => s.url) });
        } else if (item.type === "function_call") {
          calls.push(item as Extract<OutputItem, { type: "function_call" }>);
        } else if (item.type === "message") {
          const text = ((item as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("");
          if (text) finalText = text;
        }
      }
      log.event("model_response", { step, responseId: resp.id, status: resp.status, functionCalls: calls.map((c) => c.name), usage: resp.usage });

      if (!calls.length) break; // final answer
      previous = resp.id;
      input = [];
      for (const call of calls) {
        totals.toolCalls++;
        let args: Record<string, unknown> = {};
        try {
          args = call.arguments ? JSON.parse(call.arguments) : {};
        } catch {
          /* leave empty; tool will validate */
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
            } catch (e) {
              output = { error: (e as Error).message };
              log.event("tool_error", { tool: call.name, durationMs: Date.now() - t0, error: (e as Error).message });
            }
          }
        }
        input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) });
      }
      if (step === maxSteps) log.event("max_steps", { maxSteps });
    }
    const costUsd = (totals.in * PRICE.in + totals.out * PRICE.out) / 1e6 + ((totals.webSearches + totals.xSearches) * PRICE.searchPer1k) / 1000;
    log.event("run_end", { status: "ok", totals, estCostUsd: Number(costUsd.toFixed(4)), finalText });
    return { runId: log.runId, logFile: log.file, finalText, totals, estCostUsd: costUsd };
  } catch (e) {
    log.event("run_end", { status: "error", error: (e as Error).message, totals });
    throw e;
  }
}
