import "./_env";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { db, schema } from "../../src/lib/db";
import type { AgentRow, TaskRow } from "../../src/lib/db/schema";
import { HttpError } from "../../src/lib/server/http";
import { encryptSecret, sha256 } from "../../src/lib/server/util";
import { agentConfig, FILLER, lastSaid, toolPhrase, postCall, speakable, verifySignature, VOICE_NOTE, voiceLlm, voiceTaskFor, writeConfig, type VoiceRunner } from "../../src/lib/server/voice";

process.env.ELEVENLABS_CONFIG = join(mkdtempSync(join(tmpdir(), "cosign-voice-")), "elevenlabs.local.json");
const SECRET = "wsec_unit_test_secret";
const sign = (body: string, t = Math.floor(Date.now() / 1000), secret = SECRET) => `t=${t},v0=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

function voiceTask(over: Partial<TaskRow> = {}): TaskRow {
  const t: TaskRow = {
    id: `task_voice_${Math.random().toString(36).slice(2, 10)}`,
    workspaceId: "ws_unit",
    agentId: "ag_unit",
    kind: "voice",
    source: "member",
    engine: "elevenlabs",
    instructions: "Voice conversation with the CFO",
    status: "working",
    tokenHash: sha256(`tok-${Math.random()}`),
    tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    requestedBy: "mem_unit",
    scheduleId: null,
    progress: "[]",
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
  db().insert(schema.tasks).values(t).run();
  return t;
}

/** The text parts of an OpenAI-style SSE stream; also checks the chunk format and that it ends properly. */
async function read(res: Response) {
  const raw = await res.text();
  const events = raw.split("\n\n").filter(Boolean).map((e) => e.replace(/^data: /, ""));
  assert.equal(events.at(-1), "[DONE]", "the stream ends with [DONE]");
  const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
  for (const c of chunks) assert.equal(c.object, "chat.completion.chunk");
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
  assert.equal(chunks[0].choices[0].delta.role, "assistant", "the first chunk names the role");
  return chunks.map((c) => c.choices[0].delta.content).filter((x) => x !== undefined) as string[];
}

const ask = (text: string, before: { role: string; content: string }[] = []) => ({
  model: "cosign",
  stream: true,
  messages: [{ role: "system", content: "ignored" }, ...before, { role: "user", content: text }],
});

const progressOf = (id: string) => db().select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!.progress;

test("post-call signatures: right secret and fresh timestamp only", () => {
  const body = JSON.stringify({ type: "post_call_transcription", data: {} });
  assert.ok(verifySignature(body, sign(body), SECRET));
  assert.ok(!verifySignature(body, sign(body, undefined, "other-secret"), SECRET), "wrong secret");
  assert.ok(!verifySignature(body + " ", sign(body), SECRET), "body changed after signing");
  assert.ok(!verifySignature(body, sign(body, Math.floor(Date.now() / 1000) - 31 * 60), SECRET), "older than 30 minutes");
  assert.ok(!verifySignature(body, null, SECRET) && !verifySignature(body, "v0=abc", SECRET) && !verifySignature(body, "t=x,v0=abc", SECRET));
});

test("the ElevenLabs agent's brain is our endpoint, with no fallback model and no tools of its own", () => {
  const c = agentConfig({ id: "ag_x", name: "Clerk" } as AgentRow, "https://demo.example", "wh_1");
  const p = c.conversation_config.agent.prompt;
  assert.equal(p.llm, "custom-llm");
  assert.equal(p.custom_llm.url, "https://demo.example/api/v1/voice/llm");
  assert.deepEqual(p.custom_llm.request_headers, { "X-Cosign-Auth": { variable_name: "secret__cosign_auth" } }, "the token comes only from the secret variable");
  assert.deepEqual(p.backup_llm_config, { preference: "disabled" });
  assert.deepEqual(p.tool_ids, []);
  assert.equal(p.built_in_tools.skip_turn.params.system_tool_type, "skip_turn");
  assert.equal(c.conversation_config.turn.speculative_turn, false, "only finished sentences reach a turn that can draft payments");
  assert.ok(!("dynamic_variables" in agentConfig({ id: "ag_x", name: "Clerk" } as AgentRow, "https://d", "wh", { keepTestValues: true }).conversation_config.agent), "re-running setup keeps a test session loaded");
  assert.equal(c.platform_settings.auth.enable_auth, true);
  assert.ok(!JSON.stringify(c).includes("open_cosign"));
  assert.match(VOICE_NOTE, /read aloud/);
});

test("a spoken turn: our loop answers, 'One moment' first when tools run, plain speech out", async () => {
  const t = voiceTask();
  const prompts: string[] = [];
  const run: VoiceRunner = async (_task, prompt, onEvent) => {
    prompts.push(prompt);
    onEvent("tool_call", { tool: "list_proposals" }, 1);
    onEvent("policy_refused", { tool: "propose_payment", reason: "not an allowed payee" }, 2);
    return "**Proposal 4** is open:\n- $2.40 to Lena (`0x7797B992389e4a03E366DAEa33E71c0a394Df1e7`)";
  };
  const parts = await read(voiceLlm(t, ask("What's waiting for a cosign?"), { run, fillerAfterMs: 60_000 }));
  assert.deepEqual(prompts, ["What's waiting for a cosign?"], "only the newest thing the person said");
  assert.deepEqual(parts, ["One moment please, looking at what's waiting for a cosign... ", "Proposal 4 is open: $2.40 to Lena (the address ending in f1e7)."]);
  const progress = progressOf(t.id);
  for (const s of ["person: What's waiting for a cosign?", "called list_proposals", "propose_payment refused: not an allowed payee", "agent: **Proposal 4**"]) assert.ok(progress.includes(s), s);

  // a quick answer without tools: no filler
  const quick: VoiceRunner = async () => "Hi! What do you need?";
  assert.deepEqual(await read(voiceLlm(t, ask("hello", [{ role: "user", content: "What's waiting for a cosign?" }]), { run: quick, fillerAfterMs: 60_000 })), ["Hi! What do you need?"]);
});

test("silence ('...') is answered without a model turn: skip_turn when offered", async () => {
  const t = voiceTask();
  let calls = 0;
  const run: VoiceRunner = async () => (calls++, "should not run");
  const raw = await voiceLlm(t, { ...ask("..."), tools: [{ type: "function", function: { name: "skip_turn" } }] }, { run }).text();
  const chunks = raw.split("\n\n").filter(Boolean).map((e) => e.replace(/^data: /, ""));
  assert.equal(chunks.at(-1), "[DONE]");
  assert.equal(JSON.parse(chunks[0]).choices[0].delta.tool_calls[0].function.name, "skip_turn");
  assert.equal(JSON.parse(chunks[1]).choices[0].finish_reason, "tool_calls");
  assert.deepEqual(await read(voiceLlm(t, ask("..."), { run })), ["I'm here."], "fallback when skip_turn isn't offered");
  assert.deepEqual(await read(voiceLlm(t, ask(" … "), { run })), ["I'm here."]);
  assert.equal(calls, 0);
  assert.equal(progressOf(t.id), "[]", "nothing recorded");
});

test("voice says what it is doing as each tool starts: once per kind, at most three lines", async () => {
  const t = voiceTask();
  const run: VoiceRunner = async (_t, _p, onEvent) => {
    onEvent("tool_call", { tool: "list_allowed", args: { list: "sellers" } }, 1);
    onEvent("tool_call", { tool: "paid_fetch", args: { url: "http://localhost:3000/api/sellers/vendor-check?address=0x1" } }, 2);
    onEvent("tool_call", { tool: "paid_fetch", args: { url: "http://localhost:3000/api/sellers/vendor-check?address=0x2" } }, 3);
    onEvent("tool_call", { tool: "propose_payment", args: {} }, 4);
    onEvent("tool_call", { tool: "request_topup", args: {} }, 5);
    return "Proposal nine needs a cosign.";
  };
  assert.deepEqual(await read(voiceLlm(t, ask("check Lena and draft it"), { run, fillerAfterMs: 60_000 })), [
    "One moment please, checking who and what I'm allowed to pay... ",
    "Running the paid vendor check... ",
    "Drafting the payment... ",
    "Proposal nine needs a cosign.",
  ]);
  assert.equal(toolPhrase("paid_fetch", { url: "https://x/invoice-reader?invoice=1" }), "Reading the invoice with the paid invoice reader...");
  assert.equal(toolPhrase("web_search_call"), "Searching the web...");
});

test("Grok's own say_first sentence is spoken before each tool runs, in order, before the answer", async () => {
  const t = voiceTask();
  const run: VoiceRunner = async (_t, _p, onEvent) => {
    onEvent("tool_call", { tool: "paid_fetch", args: { url: "http://x/vendor-check" }, sayFirst: "I'll run the vendor check on Lena now." }, 1);
    onEvent("tool_call", { tool: "propose_payment", args: {}, sayFirst: "Looks fine, I'm drafting the one dollar payment." }, 2);
    onEvent("tool_call", { tool: "list_proposals", args: {} }, 3); // no sentence: the canned line, without "One moment" mid-turn
    return "Proposal sixteen needs a cosign.";
  };
  assert.deepEqual(await read(voiceLlm(t, ask("check Lena and draft one dollar"), { run, fillerAfterMs: 60_000 })), [
    "I'll run the vendor check on Lena now. ",
    "Looks fine, I'm drafting the one dollar payment. ",
    "Looking at what's waiting for a cosign... ",
    "Proposal sixteen needs a cosign.",
  ]);
});

test("a slow turn gets 'One moment' after a few seconds, even without tools", async () => {
  const t = voiceTask();
  const slow: VoiceRunner = () => new Promise((r) => setTimeout(() => r("Done thinking."), 80));
  assert.deepEqual(await read(voiceLlm(t, ask("think hard"), { run: slow, fillerAfterMs: 10 })), [FILLER, "Done thinking."]);
});

test("ElevenLabs retries never run a turn twice", async () => {
  const t = voiceTask();
  let calls = 0;
  let release!: (s: string) => void;
  const run: VoiceRunner = () => {
    calls++;
    return new Promise((r) => (release = r));
  };
  const a = voiceLlm(t, ask("draft the Lena payment"), { run, fillerAfterMs: 60_000 });
  const b = voiceLlm(t, ask("draft the Lena payment"), { run, fillerAfterMs: 60_000 }); // retry while it runs
  setTimeout(() => release("Drafted proposal 5. It needs a cosign."), 20);
  const [pa, pb] = await Promise.all([read(a), read(b)]);
  assert.deepEqual(pa, pb);
  assert.equal(calls, 1, "the retry joined the running turn");
  assert.deepEqual(await read(voiceLlm(t, ask("draft the Lena payment"), { run, fillerAfterMs: 60_000 })), ["Drafted proposal 5. It needs a cosign."]);
  assert.equal(calls, 1, "a late retry gets the saved answer");

  // saying the same words again later is a new turn (one more user message)
  const again = voiceLlm(t, ask("draft the Lena payment", [{ role: "user", content: "draft the Lena payment" }, { role: "assistant", content: "Drafted." }]), { run, fillerAfterMs: 60_000 });
  setTimeout(() => release("That one is already drafted."), 20);
  await read(again);
  assert.equal(calls, 2);
});

test("a re-transcribed re-send ('fifty cents' / '50 cents') joins the running turn instead of queueing another", async () => {
  const t = voiceTask();
  let calls = 0;
  let release!: (s: string) => void;
  const run: VoiceRunner = () => {
    calls++;
    return new Promise((r) => (release = r));
  };
  const a = voiceLlm(t, ask("Who can I pay? Draft fifty cents to them for invoice one three two."), { run, fillerAfterMs: 60_000 });
  const b = voiceLlm(t, ask("Who can I pay? Draft 50 cents to them for invoice one three two."), { run, fillerAfterMs: 60_000 });
  const c = voiceLlm(t, ask("Who can I pay? Draft fifty cents to them for invoice one three two, typo fixes."), { run, fillerAfterMs: 60_000 });
  setTimeout(() => release("Proposal twelve for fifty cents to Lena needs a cosign."), 20);
  const parts = await Promise.all([read(a), read(b), read(c)]);
  assert.equal(calls, 1, "one turn, one draft");
  for (const p of parts) assert.deepEqual(p, ["Proposal twelve for fifty cents to Lena needs a cosign."]);
  // a different question in the same position is a new turn (e.g. a later call in the same test session)
  const d = voiceLlm(t, ask("What's waiting for a cosign?"), { run, fillerAfterMs: 60_000 });
  setTimeout(() => release("Proposals five to twelve."), 20);
  await read(d);
  assert.equal(calls, 2);
});

test("errors are spoken and the call carries on; wrong or ended sessions are refused", async () => {
  const t = voiceTask();
  const broken: VoiceRunner = async () => {
    throw new Error("xAI is down");
  };
  assert.deepEqual(await read(voiceLlm(t, ask("hello"), { run: broken })), ["Sorry, something went wrong on my side. Please try again."]);
  assert.match(progressOf(t.id), /turn failed: xAI is down/);
  assert.deepEqual(await read(voiceLlm(t, { messages: [{ role: "system", content: "x" }] }, { run: broken })), ["Sorry, I didn't catch that."]);
  assert.throws(() => voiceLlm(t, { nope: 1 }), (e: unknown) => e instanceof HttpError && e.status === 400);
  assert.throws(() => voiceLlm(voiceTask({ kind: "task", engine: "grokbot" }), ask("hi")), (e: unknown) => e instanceof HttpError && e.status === 403);
  assert.throws(() => voiceLlm(voiceTask({ status: "done" }), ask("hi")), (e: unknown) => e instanceof HttpError && e.status === 409);
});

test("which session a turn belongs to, with errors that say what to do", () => {
  const req = (token?: string) => new Request("http://x/api/v1/voice/llm", { method: "POST", headers: token === undefined ? {} : { "x-cosign-auth": token } });
  const status = (token: string | undefined, re: RegExp, code = 401) =>
    assert.throws(() => voiceTaskFor(req(token)), (e: unknown) => e instanceof HttpError && e.status === code && re.test(e.message));
  status(undefined, /no Cosign voice session/);
  status("none", /no Cosign voice session/, 401); // the agent's placeholder: a test call with no session loaded
  status("not-a-real-token", /ended or expired/);
  status("ended-token", /ended or expired/);
  voiceTask({ tokenHash: sha256("ended-token"), tokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
  status("ended-token", /ended or expired/);
  const live = voiceTask({ tokenHash: sha256("live-token") });
  assert.equal(voiceTaskFor(req("live-token")).id, live.id);
  voiceTask({ kind: "task", engine: "grokbot", tokenHash: sha256("bot-token") });
  status("bot-token", /not for a voice session/, 403);
});

test("what the person said: the newest user message, as a string or as parts", () => {
  assert.deepEqual(lastSaid([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: [{ type: "text", text: "c" }] }]), { text: "c", n: 2 });
  assert.equal(lastSaid([{ role: "system", content: "x" }]), null);
});

test("speakable: markdown, links, addresses and hashes become something a voice can say", () => {
  assert.equal(speakable("## Open\n| id | amount |\n|---|---|\n| 4 | $2.40 |"), "Open. id, amount. 4, $2.40.");
  assert.equal(speakable("See [the explorer](https://x.io/tx/1) or https://x.io"), "See the explorer or.");
  assert.equal(speakable(`tx 0x${"ab".repeat(32)} sent`), "tx the transaction sent.");
  assert.equal(speakable("1. *first*\n2. __second__"), "first. second.");
});

test("the post-call webhook closes the session, keeps the summary, drops the secret, and ignores repeats", () => {
  writeConfig({ agents: {}, webhook: { id: "wh_unit", url: "https://demo.example/api/v1/voice/webhook", secretEnc: encryptSecret(SECRET) } });
  const t = voiceTask();
  const body = JSON.stringify({
    type: "post_call_transcription",
    event_timestamp: Math.floor(Date.now() / 1000),
    data: {
      conversation_id: "conv_unit",
      transcript: [
        { role: "agent", message: "Hi, it's Clerk." },
        { role: "user", message: "What's waiting for a cosign?" },
        { role: "agent", message: "Proposal 4, two dollars forty to Lena." },
      ],
      analysis: { transcript_summary: "The CFO asked what was waiting; Clerk named proposal 4." },
      conversation_initiation_client_data: { dynamic_variables: { cosign_session: t.id, secret__cosign_auth: "secret-token-value-must-not-be-stored" } },
    },
  });

  assert.throws(() => postCall(body, sign(body, undefined, "wrong")), (e: unknown) => e instanceof HttpError && e.status === 401);
  assert.deepEqual(postCall(body, sign(body)), { received: true, matched: true });
  const row = db().select().from(schema.tasks).where(eq(schema.tasks.id, t.id)).get()!;
  assert.equal(row.status, "done");
  assert.match(row.result ?? "", /proposal 4/);
  assert.ok(row.tokenExpiresAt! <= new Date().toISOString(), "token stops working");
  assert.ok(row.progress.includes("call ended (ElevenLabs conversation conv_unit, 3 lines)"));
  assert.ok(!JSON.stringify(row).includes("secret-token-value"), "the secret variable is never stored");
  assert.equal(postCall(body, sign(body)).duplicate, true, "ElevenLabs retries are harmless");

  // a dashboard test session (pnpm voice test) stays open across calls
  const tt = voiceTask({ source: "test" });
  const tb = JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "conv_t", conversation_initiation_client_data: { dynamic_variables: { cosign_session: tt.id } } } });
  assert.equal(postCall(tb, sign(tb)).kept, true);
  const trow = db().select().from(schema.tasks).where(eq(schema.tasks.id, tt.id)).get()!;
  assert.equal(trow.status, "working");
  assert.ok(trow.tokenExpiresAt! > new Date().toISOString(), "its token still works for the next call");

  const other = JSON.stringify({ type: "post_call_transcription", data: { conversation_initiation_client_data: { dynamic_variables: { cosign_session: "task_nope" } } } });
  assert.deepEqual(postCall(other, sign(other)), { received: true, matched: false });
});
