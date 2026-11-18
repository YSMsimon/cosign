/**
 * ElevenLabs voice (ElevenAgents), with Cosign as the only brain. Server-only.
 *
 *   ElevenLabs does the ears and the mouth: microphone, speech-to-text, turn-taking, interruptions, the
 *   voice. Its "Custom LLM" setting points at us, so every turn is answered by the normal Cosign loop:
 *   Grok, all of the agent's tools and checks, in the person's own chat thread (type, then talk, then type).
 *   ElevenLabs' own models are switched off as a fallback, so nothing answers without our rules.
 *
 *   Start  POST /agents/:id/voice (a member who may use the agent): a voice session (a task of kind
 *          "voice") with its own 30-minute token, a signed URL (the agent only starts from one), and the
 *          conversation's dynamic variables. The token is the secret one, `secret__cosign_auth`.
 *   Turns  POST /voice/llm/chat/completions, OpenAI Chat Completions, streamed. ElevenLabs puts the token in
 *          the X-Cosign-Auth header (from the secret variable, which never reaches a model). We answer the
 *          newest thing the person said; a retried request joins the turn already running, so a slow turn
 *          never runs twice. Before each tool runs, the voice says what Grok is about to do in its own words:
 *          on voice turns every tool takes a required `say_first` sentence ("I'll run the vendor check on Lena
 *          now."), spoken the moment the call arrives; a canned line covers a call without one (voice only).
 *   End    ElevenLabs' post-call webhook (HMAC-signed) → POST /voice/webhook closes the session and keeps
 *          the summary; the token stops working.
 *
 * One ElevenLabs agent per Cosign agent ("Cosign: <name>"), created by `pnpm voice setup`. Its ids and
 * the webhook secret (encrypted with COSIGN_SECRET) live in data/elevenlabs.local.json (gitignored).
 */
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import type { AgentRow, TaskRow } from "../db/schema";
import type { RunEventHandler } from "../log";
import type { Membership } from "./access";
import { memberThread, runContext, runTurn, waitForThread } from "./chat";
import { actorFor, botScope, setTask, taskForRawToken } from "./grokbot";
import { badRequest, forbidden, HttpError } from "./http";
import { decryptSecret, encryptSecret, id, newToken, safeEqual, sha256 } from "./util";
import { stillTalking } from "../voice-pause";

const now = () => new Date().toISOString();
const VOICE_TOKEN_MIN = 30;
const TEST_TOKEN_MIN = 120; // a dashboard test session spans several calls (pnpm voice test)
const API = "https://api.elevenlabs.io";
/**
 * The model for spoken turns (2026-11-15): grok-4.20's reasoning model starts talking sooner than the default model
 * (first words about 1.4 s into a warm turn instead of about 3 s) and still re-reads balances and proposals with its
 * tools. The non-reasoning one was faster still but answered from earlier in the conversation (it missed a new
 * proposal), so it isn't the default. Typed chat keeps the default model. Override with VOICE_MODEL.
 */
export const voiceModel = () => process.env.VOICE_MODEL || "grok-4.20-0309-reasoning";
export const FILLER = "One moment please... "; // spoken when a turn takes 3 s with nothing said yet (tool turns speak their say_first sooner)
const FILLER_AFTER_MS = 3000;

/** Sent to the model with every spoken turn (not stored in the thread): the reply is read aloud. */
export const VOICE_NOTE = [
  "[Voice] The person said this out loud in a live voice call, and your reply will be read aloud.",
  "Answer in one to three short spoken sentences. No markdown, lists, headings, tables, links or emoji.",
  'Say amounts the way people say them ("two dollars forty"). Never read out a full wallet address or transaction hash: use the contact\'s name, or the last four characters.',
  "If you draft a payment, say its proposal number and that it needs a cosign; Cosign shows the cosign card by itself.",
  "If the person asks you to add or request money and says how much, ask for it right away with request_funds: don't ask what it's for and don't confirm the amount first. Then say how much and that they can approve it on the screen; Cosign shows the funding card by itself.",
  "Every tool has a say_first field: one short sentence of what you are about to do, read aloud before the tool runs. Don't repeat it in your answer.",
  "Balances, proposals, payees and limits change all the time: whenever the answer depends on them, read them with your tools in this turn. Never repeat a number from earlier in the conversation as if it were current.",
].join(" ");

// ───────────── local config (ElevenLabs ids, encrypted webhook secret) ─────────────

export type VoiceConfig = {
  base?: string;
  webhook?: { id: string; url: string; secretEnc: string };
  agents: Record<string, { elevenAgentId: string; name: string }>; // Cosign agent id → ElevenLabs agent
};

const configFile = () => process.env.ELEVENLABS_CONFIG ?? "data/elevenlabs.local.json";

export function readConfig(): VoiceConfig {
  const f = configFile();
  if (!existsSync(f)) return { agents: {} };
  const c = JSON.parse(readFileSync(f, "utf8")) as Partial<VoiceConfig>;
  return { agents: c.agents ?? {}, webhook: c.webhook, base: c.base };
}

export function writeConfig(c: VoiceConfig) {
  const f = configFile();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}

// ───────────── ElevenLabs REST ─────────────

export async function el<T = Record<string, unknown>>(path: string, o: { method?: string; body?: unknown } = {}): Promise<T> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new HttpError(503, "ELEVENLABS_API_KEY is not set in .env.local");
  const method = o.method ?? "GET";
  const r = await fetch(API + path, {
    method,
    headers: { "xi-api-key": key, ...(o.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  if (!r.ok) throw new HttpError(502, `ElevenLabs ${method} ${path.split("?")[0]} answered ${r.status}: ${text.replace(/\s+/g, " ").slice(0, 400)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

// ───────────── the ElevenLabs agent ─────────────

/** ElevenLabs sends this to our endpoint as the system message; we ignore it (our loop has the agent's real instructions). */
const AGENT_PROMPT = "You are {{agent_name}}, a Cosign finance agent. Cosign's server writes every reply in this conversation.";

const placeholders = (agent: AgentRow) => ({ agent_name: agent.name, cosign_session: "none", secret__cosign_auth: "none" });

export const llmUrl = (base: string) => `${base}/api/v1/voice/llm`;

/** The events a call's page receives: ElevenLabs' defaults, plus agent_chat_response_part for the live caption. */
export const CLIENT_EVENTS = ["audio", "interruption", "agent_response", "user_transcript", "agent_response_correction", "agent_tool_response", "agent_chat_response_part"];

export function agentConfig(agent: AgentRow, base: string, webhookId?: string, o: { keepTestValues?: boolean } = {}) {
  return {
    name: `Cosign: ${agent.name}`,
    tags: ["cosign"],
    conversation_config: {
      // no speculative turns: a turn can draft a payment, so we answer only what the person finished saying.
      // Eager turn-taking: answer as soon as the person finishes a sentence (normal waited seconds through pauses).
      turn: { speculative_turn: false, turn_eagerness: "eager" },
      agent: {
        first_message: "Hi, it's {{agent_name}}. What do you need?",
        language: "en",
        ...(o.keepTestValues ? {} : { dynamic_variables: { dynamic_variable_placeholders: placeholders(agent) } }),
        prompt: {
          prompt: AGENT_PROMPT,
          llm: "custom-llm",
          custom_llm: {
            url: llmUrl(base),
            model_id: "cosign",
            api_type: "chat_completions",
            request_headers: { "X-Cosign-Auth": { variable_name: "secret__cosign_auth" } },
          },
          backup_llm_config: { preference: "disabled" }, // never fall back to a model without our rules
          cascade_timeout_seconds: 15, // the longest ElevenLabs allows; we also speak "One moment... " early
          tool_ids: [],
          // lets our endpoint stay silent when the person goes quiet (ElevenLabs then waits for them to speak)
          built_in_tools: { skip_turn: { type: "system", name: "skip_turn", description: "", pre_tool_speech: "off", params: { system_tool_type: "skip_turn" } } },
        },
      },
      ...(process.env.ELEVENLABS_VOICE_ID ? { tts: { voice_id: process.env.ELEVENLABS_VOICE_ID } } : {}),
      // what the page hears: ElevenLabs' defaults, plus the answer's text as it is written (the call's caption)
      conversation: { client_events: CLIENT_EVENTS },
    },
    platform_settings: {
      auth: { enable_auth: true }, // conversations start only from a signed URL we hand out
      ...(webhookId ? { workspace_overrides: { webhooks: { post_call_webhook_id: webhookId, events: ["transcript", "call_initiation_failure"] } } } : {}),
    },
  };
}

/**
 * Create or update everything on ElevenLabs for one Cosign agent: the post-call webhook (its URL can't be
 * edited, so a new base gets a new webhook and the old one is disabled, not deleted), and the agent
 * "Cosign: <name>" pointed at our custom-LLM endpoint. Safe to run again.
 */
export async function setupVoice(agent: AgentRow, base: string, log: (s: string) => void = () => {}) {
  const cfg = readConfig();
  const hookUrl = `${base}/api/v1/voice/webhook`;
  if (cfg.webhook?.url !== hookUrl) {
    if (cfg.webhook) {
      await el(`/v1/workspace/webhooks/${cfg.webhook.id}`, { method: "PATCH", body: { is_disabled: true, name: "Cosign post-call (old URL)" } }).catch(() => {});
      log("old post-call webhook disabled");
    }
    const w = await el<{ webhook_id: string; webhook_secret?: string | null }>("/v1/workspace/webhooks", {
      method: "POST",
      body: { settings: { auth_type: "hmac", name: "Cosign post-call", webhook_url: hookUrl } },
    });
    if (!w.webhook_secret) throw new Error("ElevenLabs created the webhook but returned no signing secret");
    cfg.webhook = { id: w.webhook_id, url: hookUrl, secretEnc: encryptSecret(w.webhook_secret) };
    writeConfig(cfg);
    log(`post-call webhook created → ${hookUrl}`);
  }

  const existing = cfg.agents[agent.id];
  const body = agentConfig(agent, base, cfg.webhook!.id, { keepTestValues: !!existing }); // a running pnpm voice test keeps its session
  if (existing) await el(`/v1/convai/agents/${existing.elevenAgentId}`, { method: "PATCH", body });
  else cfg.agents[agent.id] = { elevenAgentId: (await el<{ agent_id: string }>("/v1/convai/agents/create", { method: "POST", body })).agent_id, name: agent.name };
  cfg.base = base;
  writeConfig(cfg);
  log(`agent "Cosign: ${agent.name}" ${existing ? "updated" : "created"}; its brain is ${llmUrl(base)}`);
  return { elevenAgentId: cfg.agents[agent.id].elevenAgentId, llm: llmUrl(base), webhook: hookUrl };
}

/** Put a session's values into the agent's test values, so the dashboard's test call uses them. */
export async function setTestValues(elevenAgentId: string, vars: Record<string, string>) {
  await el(`/v1/convai/agents/${elevenAgentId}`, { method: "PATCH", body: { conversation_config: { agent: { dynamic_variables: { dynamic_variable_placeholders: vars } } } } });
}

export async function clearTestValues(agent: AgentRow) {
  const va = readConfig().agents[agent.id];
  if (va) await setTestValues(va.elevenAgentId, placeholders(agent));
}

/** Voice can be set up on the first call: ElevenLabs is configured and we know our public address (from an earlier setup). */
const canSetUp = (c: VoiceConfig) => !!process.env.ELEVENLABS_API_KEY && !!(c.base ?? process.env.PUBLIC_BASE_URL);

export function voiceStatus(agent: AgentRow) {
  const c = readConfig();
  const va = c.agents[agent.id];
  const configured = !!va && !!c.webhook;
  // ready: Talk works now, or sets this agent's voice up on the first call
  return { configured, ready: configured || canSetUp(c), elevenAgentId: va?.elevenAgentId ?? null, llm: c.base ? llmUrl(c.base) : null, webhook: c.webhook?.url ?? null };
}

/** One setup at a time per agent (two quick Talk presses must not create two ElevenLabs agents). */
const gSetups = globalThis as unknown as { __cosignVoiceSetups?: Map<string, Promise<unknown>> };
const setups = (gSetups.__cosignVoiceSetups ??= new Map());

/** The agent's ElevenLabs voice, set up now if it has none yet (same as `pnpm voice setup <name>`). */
async function ensureAgentVoice(agent: AgentRow) {
  const c = readConfig();
  if (c.agents[agent.id] && c.webhook) return;
  if (!canSetUp(c)) throw new HttpError(409, `voice is not set up for ${agent.name}; run: pnpm voice setup ${agent.name}`);
  const base = (c.base ?? process.env.PUBLIC_BASE_URL!).replace(/\/$/, "");
  const running = setups.get(agent.id) ?? setupVoice(agent, base).finally(() => setups.delete(agent.id));
  setups.set(agent.id, running);
  await running;
}

// ───────────── a voice session ─────────────

/**
 * Open a voice session for the member: a task of kind "voice" whose token only works for this
 * conversation, for 30 minutes, and stops when ElevenLabs reports the call ended.
 * The caller has already checked that the member may use the agent.
 */
export async function startVoice(m: Membership, agent: AgentRow, o: { signedUrl?: boolean; warm?: boolean; test?: boolean } = {}) {
  await ensureAgentVoice(agent); // a new agent gets its voice on its first call
  const va = readConfig().agents[agent.id];
  if (!va) throw new HttpError(409, `voice is not set up for ${agent.name}; run: pnpm voice setup ${agent.name}`);
  const token = newToken();
  const expiresAt = new Date(Date.now() + (o.test ? TEST_TOKEN_MIN : VOICE_TOKEN_MIN) * 60_000).toISOString();
  const task: TaskRow = {
    id: id("task"),
    workspaceId: m.workspace.id,
    agentId: agent.id,
    kind: "voice",
    source: o.test ? "test" : "member", // "test": the ElevenLabs dashboard keeps the values it loaded, so one session serves every test call
    engine: "elevenlabs",
    instructions: `${o.test ? "Dashboard voice test" : "Voice conversation"} with the ${m.member.title?.trim() || "member"}`,
    status: "working",
    tokenHash: sha256(token),
    tokenExpiresAt: expiresAt,
    requestedBy: m.member.id,
    scheduleId: null,
    progress: "[]",
    result: null,
    error: null,
    roomId: null,
    createdAt: now(),
    updatedAt: now(),
  };
  db().insert(schema.tasks).values(task).run();
  // start the agent's microVM now, so the first spoken turn doesn't wait for it
  if (o.warm !== false) void runContext(agent, m.workspace, actorFor(m.member.id), { taskId: task.id }).catch(() => {});
  try {
    const signedUrl =
      o.signedUrl === false ? null : (await el<{ signed_url: string }>(`/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(va.elevenAgentId)}`)).signed_url;
    const dynamicVariables = { cosign_session: task.id, agent_name: agent.name, secret__cosign_auth: token };
    return { sessionId: task.id, elevenAgentId: va.elevenAgentId, signedUrl, dynamicVariables, expiresAt };
  } catch (e) {
    setTask(task.id, { status: "failed", error: (e as Error).message, tokenExpiresAt: now() });
    throw e;
  }
}

function addProgress(taskId: string, message: string) {
  const t = db().select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  if (!t) return;
  const progress = JSON.parse(t.progress) as { t: string; message: string }[];
  setTask(taskId, { progress: JSON.stringify([...progress, { t: now(), message }]) });
}

/** The voice session a custom-LLM request belongs to (token from X-Cosign-Auth, or a Bearer header). */
export function voiceTaskFor(req: Request): TaskRow {
  const h = req.headers.get("x-cosign-auth") ?? req.headers.get("authorization") ?? "";
  const token = h.replace(/^Bearer\s+/i, "").trim();
  // "none" is the agent's placeholder: a call started without a session (e.g. a dashboard test call with no pnpm voice test running)
  if (!token || token === "none") throw new HttpError(401, "no Cosign voice session: start the call from Cosign (or run pnpm voice test first)");
  let task: TaskRow;
  try {
    task = taskForRawToken(token);
  } catch {
    throw new HttpError(401, "this Cosign voice session has ended or expired: start a new call");
  }
  if (task.kind !== "voice") throw forbidden("this token is not for a voice session");
  return task;
}

// ───────────── turns (ElevenLabs → our loop) ─────────────

/** Runs one spoken turn and returns the answer text. The default is the normal Cosign loop. */
export type VoiceRunner = (task: TaskRow, prompt: string, onEvent: RunEventHandler) => Promise<string>;

export const runVoiceTurn: VoiceRunner = async (task, prompt, onEvent) => {
  const { agent, ws, actor } = botScope(task);
  if (!task.requestedBy) throw forbidden("this voice session has no person");
  const thread = memberThread(task.requestedBy);
  for (let attempt = 0; ; attempt++) {
    await waitForThread(agent.ref, thread); // the person's typed turn (or an earlier spoken one) finishes first
    try {
      const r = await runTurn(agent, ws, actor, thread, prompt, onEvent, task.id, { turnNote: VOICE_NOTE, via: "voice", stream: true, model: voiceModel() });
      return r.finalText;
    } catch (e) {
      if (e instanceof HttpError && e.status === 409 && attempt < 2) continue; // another turn slipped in first
      throw e;
    }
  }
};

type Said = { text: string; n: number }; // the newest thing the person said, and how many times they've spoken
/** Something to say during a turn: a progress line (Grok's own say_first, or our canned one), or a sentence of the answer. */
type Update = { text: string; canned: boolean; answer?: boolean };
type Turn = { said: Said; updates: Update[]; subs: Set<() => void>; result: Promise<string> };

/**
 * Is this the same utterance as before? ElevenLabs re-sends what the person just said, sometimes re-transcribed
 * ("fifty cents" / "50 cents") or with a few more words: same position in the conversation, mostly the same words.
 */
export function sameUtterance(a: Said, b: Said): boolean {
  if (a.n !== b.n) return false;
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean));
  const A = words(a.text);
  const B = words(b.text);
  if (!A.size || !B.size) return a.text === b.text;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / Math.min(A.size, B.size) >= 0.6;
}

/** What the voice says the moment the agent picks a tool, before the tool runs (voice only; the chat shows steps). */
export function toolPhrase(tool: string, args: Record<string, unknown> = {}): string {
  const url = String(args.url ?? "");
  switch (tool) {
    case "get_balances":
      return "Checking your balances...";
    case "list_proposals":
      return "Looking at what's waiting for a cosign...";
    case "list_allowed":
      return "Checking who and what I'm allowed to pay...";
    case "paid_fetch":
      return /invoice/i.test(url) ? "Reading the invoice with the paid invoice reader..." : /vendor/i.test(url) ? "Running the paid vendor check..." : "Calling the paid API...";
    case "discover_services":
      return "Searching the paid API directory...";
    case "propose_payment":
      return "Drafting the payment...";
    case "request_topup":
      return "Drawing petty cash...";
    case "send_usdc":
      return "Sending the USDC from my wallet...";
    case "swap":
      return args.dry_run ? "Checking the swap price..." : "Swapping in my wallet...";
    case "bridge":
      return "Bridging the USDC over CCTP...";
    case "gateway_deposit":
      return "Topping up my Gateway balance...";
    case "earn":
      return "Checking the earn vault...";
    case "borrow":
      return "Checking the borrow rates...";
    case "request_funds":
      return "Asking someone to add funds to the treasury...";
    case "list_team":
      return "Checking who's on the team...";
    case "mention":
      return args.who ? `Passing this to ${String(args.who).replace(/^@/, "")}...` : "Passing this to a teammate...";
    case "memory_read":
    case "memory_search":
      return "Checking my notes...";
    case "memory_write":
    case "memory_archive":
      return "Updating my notes...";
    case "read_file":
    case "list_dir":
      return /policy/i.test(String(args.path ?? "")) ? "Checking my rules..." : "Checking the company files...";
    case "sandbox_bash":
    case "write_file":
    case "edit_file":
      return "Working it out on my computer...";
    case "web_search_call":
      return "Searching the web...";
    case "x_search_call":
      return "Searching X...";
    default:
      return "Working on it...";
  }
}
const MAX_UPDATES = 3; // spoken progress lines per turn
type Answered = { said: Said; reply: string; at: number };
const g = globalThis as unknown as { __cosignVoiceTurns?: Map<string, Turn>; __cosignVoiceAnswered?: Map<string, Answered> };
const running = (g.__cosignVoiceTurns ??= new Map()); // session → the turn being answered
const answered = (g.__cosignVoiceAnswered ??= new Map()); // session → the last finished turn (for late re-sends)

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("");
  return "";
}

export function lastSaid(messages: { role?: unknown; content?: unknown }[]): Said | null {
  const users = messages.filter((x) => x?.role === "user");
  const text = textOf(users.at(-1)?.content).trim();
  return text ? { text, n: users.length } : null;
}

function turnFor(task: TaskRow, said: Said, run: VoiceRunner): { turn: Turn } | { cached: string } {
  // ElevenLabs re-sent (or re-transcribed) what the person just said: join the turn already running, never run it
  // twice, and the person hears the real result as soon as it is ready
  const cur = running.get(task.id);
  if (cur && sameUtterance(cur.said, said)) return { turn: cur };
  const done = answered.get(task.id);
  if (done && Date.now() - done.at < 60_000 && sameUtterance(done.said, said)) return { cached: done.reply };
  const before = cur?.result.catch(() => "") ?? Promise.resolve("");
  const name = db().select({ name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, task.agentId)).get()?.name ?? "agent";
  const turn: Turn = { said, updates: [], subs: new Set(), result: Promise.resolve("") };
  const progress = (text: string, canned: boolean) => {
    if (!text || turn.updates.some((u) => u.text === text) || turn.updates.filter((u) => !u.answer).length >= MAX_UPDATES) return;
    turn.updates.push({ text, canned });
    for (const f of turn.subs) f();
  };
  // the answer as Grok writes it, said a whole sentence at a time (so "$3.84" or an address is never cut in two):
  // the voice starts on the first sentence instead of waiting for the whole turn
  let pending = "";
  const answer = (all: boolean) => {
    for (;;) {
      const m = all ? /^[\s\S]*\S[\s\S]*$/.exec(pending) : /^[\s\S]*?(?:[.!?](?=\s)|\n)/.exec(pending);
      if (!m) return;
      pending = pending.slice(m[0].length);
      const text = speakable(m[0]);
      if (text) {
        turn.updates.push({ text, canned: false, answer: true });
        for (const f of turn.subs) f();
      }
      if (all) return;
    }
  };
  turn.result = (async () => {
    const t0 = Date.now();
    await before; // the person spoke again before the last answer was done: that one finishes first
    const tStart = Date.now();
    let tFirst = 0;
    const tools: string[] = [];
    addProgress(task.id, `person: ${said.text.slice(0, 500)}`);
    try {
      const text = await run(task, said.text, (type, data) => {
        if (type === "text_delta") {
          pending += String(data.text ?? "");
          answer(false);
          return;
        }
        if (type === "model_request") answer(true); // words written before a tool call are said before it runs
        if (type === "tool_call" || type === "server_tool") {
          tFirst ||= Date.now();
          tools.push(String(data.tool));
        }
        if (type === "tool_call") {
          const own = typeof data.sayFirst === "string" ? speakable(data.sayFirst) : ""; // Grok's own words, said before the tool runs
          progress(own || toolPhrase(String(data.tool), (data.args as Record<string, unknown>) ?? {}), !own);
        }
        if (type === "server_tool") progress(toolPhrase(String(data.tool)), true);
        // with its arguments, so the call's step line can say what it did ("Drafted $0.10 to Lena", not "Drafted to")
        if (type === "tool_call") addProgress(task.id, `called ${data.tool} ${JSON.stringify(data.args ?? {})}`.slice(0, 600));
        else if (type === "policy_refused") addProgress(task.id, `${data.tool} refused: ${data.reason}`);
        else if (type === "tool_error") addProgress(task.id, `${data.tool} failed: ${data.error}`);
        else if (type === "server_tool") addProgress(task.id, `searched (${String(data.tool).replace(/_call$/, "")}): ${data.query ?? ""}`);
      });
      answer(true); // the last words of the answer
      answered.set(task.id, { said, reply: text, at: Date.now() });
      addProgress(task.id, `${name}: ${text.slice(0, 800)}`);
      const end = Date.now();
      // one line per spoken turn in the server log: where the person's wait went
      console.info(
        `[voice] ${task.id} turn ${((end - t0) / 1000).toFixed(1)}s: queued ${((tStart - t0) / 1000).toFixed(1)}s, first words ${(((tFirst || end) - t0) / 1000).toFixed(1)}s, tools ${tools.join(",") || "none"}`,
      );
      return text;
    } catch (e) {
      addProgress(task.id, `turn failed: ${(e as Error).message.slice(0, 300)}`);
      throw e;
    }
  })().finally(() => {
    if (running.get(task.id) === turn) running.delete(task.id);
  });
  running.set(task.id, turn);
  return { turn };
}

/** Markdown and chain identifiers → something a voice can say. A backstop: the voice note asks for plain speech. */
export function speakable(md: string): string {
  let s = md.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/`([^`]*)`/g, "$1");
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/https?:\/\/\S+/g, "");
  s = s.replace(/\b0x[a-fA-F0-9]{64}\b/g, "the transaction");
  s = s.replace(/\b0x[a-fA-F0-9]{40}\b/g, (a) => `the address ending in ${a.slice(-4)}`);
  s = s.replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/(^|\s)[*_](\S(?:.*?\S)?)[*_](?=\s|[.,!?;:]|$)/gm, "$1$2");
  s = s.replace(/^\s*\|(.*)\|\s*$/gm, (_, row: string) =>
    row
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c && !/^:?-+:?$/.test(c))
      .join(", "),
  );
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/^\s*>\s?/gm, "").replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "");
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.map((l) => (/[.!?:;,]$/.test(l) ? l : `${l}.`)).join(" ").replace(/\s+/g, " ").trim();
}

export { stillTalking } from "../voice-pause";

/**
 * One custom-LLM request from ElevenLabs: answer the newest thing the person said with the Cosign loop,
 * streamed in the OpenAI Chat Completions chunk format. Errors are spoken, so the call carries on.
 */
export function voiceLlm(task: TaskRow, body: unknown, o: { signal?: AbortSignal; run?: VoiceRunner; fillerAfterMs?: number } = {}): Response {
  if (task.kind !== "voice") throw forbidden("this token is not for a voice session");
  if (task.status === "done" || task.status === "failed") throw new HttpError(409, "this voice session has ended");
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) throw badRequest("messages must be an array");
  const said = lastSaid(messages as { role?: unknown; content?: unknown }[]);
  // ElevenLabs sends "..." when the person goes quiet: no model turn, nothing in the thread; stay silent (skip_turn) when offered
  const tools = (body as { tools?: { function?: { name?: string } }[] }).tools;
  const canSkip = Array.isArray(tools) && tools.some((t) => t?.function?.name === "skip_turn");
  const silent = !!said && stillTalking(said.text);
  const src = !said ? null : silent ? (canSkip ? { skip: true as const } : { cached: "I'm here." }) : turnFor(task, said, o.run ?? runVoiceTurn);

  const enc = new TextEncoder();
  const cid = `chatcmpl-${randomBytes(8).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: cid, object: "chat.completion.chunk", created, model: "cosign", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      let first = true;
      const write = (s: string) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          open = false;
        }
      };
      const say = (text: string) => {
        if (!text) return;
        write(chunk(first ? { role: "assistant", content: text } : { content: text }));
        first = false;
      };
      o.signal?.addEventListener("abort", () => {
        open = false; // the person interrupted: stop talking; the turn itself still finishes and is kept in the thread
        cleanup();
      });

      if (src && "skip" in src) {
        write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${cid.slice(9)}`, type: "function", function: { name: "skip_turn", arguments: '{"reason":"the person is quiet"}' } }] }));
        write(chunk({}, "tool_calls"));
        write("data: [DONE]\n\n");
        try {
          controller.close();
        } catch {}
        return;
      }
      if (!src) say("Sorry, I didn't catch that.");
      else if ("cached" in src) say(speakable(src.cached) || "Done.");
      else {
        const t = src.turn;
        let spoken = 0; // progress lines said so far
        let anything = false;
        const speakProgress = () => {
          while (spoken < t.updates.length) {
            const { text, canned } = t.updates[spoken++];
            say(canned && !anything ? `One moment please, ${text.charAt(0).toLowerCase()}${text.slice(1)} ` : `${text} `);
            anything = true;
          }
        };
        const streamed = () => t.updates.some((u) => u.answer);
        const timer = setTimeout(() => {
          if (anything) return;
          anything = true;
          say(FILLER);
        }, o.fillerAfterMs ?? FILLER_AFTER_MS);
        cleanup = () => {
          clearTimeout(timer);
          t.subs.delete(speakProgress);
        };
        t.subs.add(speakProgress);
        speakProgress(); // a retry that joins a running turn catches up
        let reply: string | null;
        try {
          const text = await t.result;
          speakProgress();
          reply = streamed() ? null : speakable(text) || "Done."; // already said sentence by sentence
        } catch {
          reply = "Sorry, something went wrong on my side. Please try again.";
        }
        cleanup();
        if (reply) say(reply);
      }
      write(chunk({}, "stop"));
      write("data: [DONE]\n\n");
      try {
        controller.close();
      } catch {}
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}

// ───────────── post-call webhook ─────────────

/** ElevenLabs-Signature: "t=<unix seconds>,v0=<hex HMAC-SHA256 of `${t}.${rawBody}`>", valid for 30 minutes. */
export function verifySignature(rawBody: string, header: string | null, secret: string, nowMs = Date.now()): boolean {
  if (!header) return false;
  const parts = header.split(",").map((s) => s.trim());
  const t = parts.find((p) => p.startsWith("t="))?.slice(2);
  const v0 = parts.find((p) => p.startsWith("v0="));
  if (!t || !v0 || !/^\d+$/.test(t)) return false;
  if (Number(t) * 1000 < nowMs - 30 * 60_000) return false;
  return safeEqual(v0, "v0=" + createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
}

type PostCallEvent = {
  type?: string;
  data?: {
    conversation_id?: string;
    transcript?: { role?: string; message?: string | null }[];
    analysis?: { transcript_summary?: string | null; call_successful?: string | null };
    conversation_initiation_client_data?: { dynamic_variables?: Record<string, unknown> };
  };
};

/**
 * Close the voice session the call belonged to. The turns are already in the person's thread and on the
 * session's progress; this keeps ElevenLabs' summary. The payload carries the conversation's dynamic
 * variables, including the secret token: we read only cosign_session and never store or log the rest.
 */
export function postCall(rawBody: string, signature: string | null) {
  const cfg = readConfig();
  if (!cfg.webhook) throw new HttpError(503, "voice webhook is not set up");
  if (!verifySignature(rawBody, signature, decryptSecret(cfg.webhook.secretEnc))) throw new HttpError(401, "bad signature");
  let ev: PostCallEvent;
  try {
    ev = JSON.parse(rawBody) as PostCallEvent;
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
  const data = ev.data ?? {};
  const sid = data.conversation_initiation_client_data?.dynamic_variables?.cosign_session;
  const task = typeof sid === "string" ? db().select().from(schema.tasks).where(eq(schema.tasks.id, sid)).get() : undefined;
  if (!task || task.kind !== "voice") return { received: true, matched: false };
  if (task.status === "done" || task.status === "failed") return { received: true, matched: true, duplicate: true };
  answered.delete(task.id);
  if (task.source === "test") {
    addProgress(task.id, `call ended (ElevenLabs conversation ${data.conversation_id ?? "?"}); the test session stays open for the next call`);
    return { received: true, matched: true, kept: true };
  }

  if (ev.type === "call_initiation_failure") {
    setTask(task.id, { status: "failed", error: "the voice call did not start", tokenExpiresAt: now() });
    return { received: true, matched: true };
  }
  if (ev.type !== "post_call_transcription") return { received: true, matched: true, ignored: ev.type ?? "unknown" };

  const said = (data.transcript ?? []).filter((x) => x.message);
  const lastAgent = [...said].reverse().find((x) => x.role === "agent")?.message;
  const progress = [
    ...(JSON.parse(task.progress) as { t: string; message: string }[]),
    { t: now(), message: `call ended (ElevenLabs conversation ${data.conversation_id ?? "?"}, ${said.length} lines)` },
  ];
  setTask(task.id, {
    status: "done",
    result: data.analysis?.transcript_summary || lastAgent || "voice conversation ended",
    progress: JSON.stringify(progress),
    tokenExpiresAt: now(),
  });
  return { received: true, matched: true };
}
