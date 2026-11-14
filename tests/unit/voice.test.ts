import "./_env";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { TOOLS } from "../../src/lib/agent/tools";
import { db, schema } from "../../src/lib/db";
import type { TaskRow } from "../../src/lib/db/schema";
import { HttpError } from "../../src/lib/server/http";
import { encryptSecret, sha256 } from "../../src/lib/server/util";
import { postCall, verifySignature, voiceTool, VOICE_TOOLS, webhookToolConfig, writeConfig } from "../../src/lib/server/voice";

process.env.ELEVENLABS_CONFIG = join(mkdtempSync(join(tmpdir(), "cosign-voice-")), "elevenlabs.local.json");
const SECRET = "wsec_unit_test_secret";
const sign = (body: string, t = Math.floor(Date.now() / 1000), secret = SECRET) => `t=${t},v0=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

test("post-call signatures: right secret and fresh timestamp only", () => {
  const body = JSON.stringify({ type: "post_call_transcription", data: {} });
  assert.ok(verifySignature(body, sign(body), SECRET));
  assert.ok(!verifySignature(body, sign(body, undefined, "other-secret"), SECRET), "wrong secret");
  assert.ok(!verifySignature(body + " ", sign(body), SECRET), "body changed after signing");
  assert.ok(!verifySignature(body, sign(body, Math.floor(Date.now() / 1000) - 31 * 60), SECRET), "older than 30 minutes");
  assert.ok(!verifySignature(body, null, SECRET) && !verifySignature(body, "v0=abc", SECRET) && !verifySignature(body, "t=x,v0=abc", SECRET));
});

test("voice tools: our endpoint, token only from the secret variable, every LLM field described", () => {
  const voice = TOOLS.filter((t) => VOICE_TOOLS.has(t.name));
  assert.equal(voice.length, VOICE_TOOLS.size, "every voice tool exists");
  assert.ok(!VOICE_TOOLS.has("sandbox_bash") && !VOICE_TOOLS.has("memory_archive"));
  for (const t of voice) {
    const c = webhookToolConfig(t, "https://demo.example");
    assert.equal(c.api_schema.url, `https://demo.example/api/v1/voice/tools/${t.name}`);
    assert.deepEqual(c.api_schema.request_headers, { Authorization: { variable_name: "secret__cosign_auth" } });
    const body = (c.api_schema as { request_body_schema?: { properties: Record<string, { type: string; description: string }> } }).request_body_schema;
    for (const [k, p] of Object.entries(body?.properties ?? {})) assert.ok(p.type && p.description, `${t.name}.${k}`);
    assert.ok(!JSON.stringify(c).includes("additionalProperties"));
  }
});

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
    tokenHash: sha256("tok"),
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

test("a Grok Bot task token can't call the voice tools", async () => {
  const t = voiceTask({ kind: "task", engine: "grokbot" });
  await assert.rejects(() => voiceTool(t, "get_balances", {}), (e: unknown) => e instanceof HttpError && e.status === 403);
});

test("the post-call webhook closes the session, keeps the transcript, drops the secret, and ignores repeats", () => {
  writeConfig({ tools: {}, agents: {}, webhook: { id: "wh_unit", url: "https://demo.example/api/v1/voice/webhook", secretEnc: encryptSecret(SECRET) } });
  const t = voiceTask();
  const token = "Bearer secret-token-value-must-not-be-stored";
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
      conversation_initiation_client_data: { dynamic_variables: { cosign_session: t.id, secret__cosign_auth: token } },
    },
  });

  assert.throws(() => postCall(body, sign(body, undefined, "wrong")), (e: unknown) => e instanceof HttpError && e.status === 401);
  assert.deepEqual(postCall(body, sign(body)), { received: true, matched: true });
  const row = db().select().from(schema.tasks).where(eq(schema.tasks.id, t.id)).get()!;
  assert.equal(row.status, "done");
  assert.match(row.result ?? "", /proposal 4/);
  assert.ok(row.tokenExpiresAt! <= new Date().toISOString(), "token stops working");
  assert.ok(row.progress.includes("person: What's waiting for a cosign?"));
  assert.ok(!JSON.stringify(row).includes("secret-token-value"), "the secret variable is never stored");
  assert.equal(postCall(body, sign(body)).duplicate, true, "ElevenLabs retries are harmless");

  const other = JSON.stringify({ type: "post_call_transcription", data: { conversation_initiation_client_data: { dynamic_variables: { cosign_session: "task_nope" } } } });
  assert.deepEqual(postCall(other, sign(other)), { received: true, matched: false });
});
