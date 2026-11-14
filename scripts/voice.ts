/**
 * ElevenLabs voice for a demo agent, from the terminal (acts as the Test CFO, like pnpm grokbot).
 *
 *   pnpm voice setup [agent]           create or update "Cosign: <agent>" on ElevenLabs: its brain is our
 *                                      custom-LLM endpoint (the normal Cosign loop), plus the post-call webhook
 *   pnpm voice try [agent] [message]   a real conversation through ElevenLabs without a microphone: types the
 *                                      message over their WebSocket and prints what the agent answers
 *   pnpm voice test [agent]            open a voice session and load it into that agent's test values, then talk
 *                                      to it with the ElevenLabs dashboard's test call; turns and tool calls show
 *                                      here live, and the session closes when the call ends
 *   pnpm voice logs [agent] [n]        ElevenLabs' record of the last n calls: transcript, how long each answer took, why a call ended
 *   pnpm voice status [agent]
 *
 * [agent] is an agent name in the demo workspace (default: Clerk). Needs ELEVENLABS_API_KEY in .env.local, `pnpm dev`,
 * and a public URL (PUBLIC_BASE_URL or a running ngrok tunnel). Run setup again whenever the public URL changes.
 */
import { desc, eq, and } from "drizzle-orm";
import { db, schema } from "../src/lib/db";
import { setTask } from "../src/lib/server/grokbot";
import { clearTestValues, el, readConfig, setTestValues, setupVoice, startVoice, voiceStatus } from "../src/lib/server/voice";
import { checkReachable, demo, follow, publicBase } from "./lib/demo";

async function ready(agentName: string, agentId: string) {
  const cfg = readConfig();
  const va = cfg.agents[agentId];
  if (!va) throw new Error(`voice is not set up for ${agentName}; run pnpm voice setup ${agentName}`);
  const base = await publicBase();
  if (cfg.base !== base) throw new Error(`the public URL changed (${cfg.base} → ${base}); run pnpm voice setup ${agentName} again`);
  await checkReachable(base);
  return va;
}

function progressOf(taskId: string) {
  const t = db().select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  return t ? (JSON.parse(t.progress) as { t: string; message: string }[]) : [];
}

(async () => {
  const [cmd = "status", agentName = "Clerk", ...rest] = process.argv.slice(2);
  const { m, agent } = demo(agentName);

  if (cmd === "setup") {
    if (!process.env.ELEVENLABS_API_KEY) throw new Error("add ELEVENLABS_API_KEY to .env.local first (ElevenLabs → Developers → API keys)");
    const base = await publicBase();
    await checkReachable(base);
    console.log(`Setting up "Cosign: ${agent.name}" on ElevenLabs, answered by ${base}`);
    const r = await setupVoice(agent, base, (s) => console.log(`  · ${s}`));
    console.log(`\nREADY: ElevenLabs agent ${r.elevenAgentId}. Next: pnpm voice try ${agent.name}`);
    return;
  }

  if (cmd === "try") {
    const message = rest.join(" ").trim() || "What's waiting for a cosign?";
    await ready(agent.name, agent.id);
    const s = await startVoice(m, agent, { warm: false });
    const closeSession = () => setTask(s.sessionId, { tokenExpiresAt: new Date().toISOString() });
    console.log(`Voice session ${s.sessionId}. Connecting to ElevenLabs (text in, the agent's words out)...`);
    const replies: string[] = [];
    const t0 = Date.now();
    await new Promise<void>((resolve, reject) => {
      const sock = new WebSocket(s.signedUrl!);
      let sent = false;
      let settled = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        try {
          sock.close();
        } catch {}
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => finish(new Error("no answer within 120 s")), 120_000);
      const send = () => {
        if (sent) return;
        sent = true;
        console.log(`you: ${message}`);
        sock.send(JSON.stringify({ type: "user_message", text: message }));
      };
      sock.onopen = () => sock.send(JSON.stringify({ type: "conversation_initiation_client_data", dynamic_variables: s.dynamicVariables }));
      sock.onmessage = (ev) => {
        const d = JSON.parse(String(ev.data)) as {
          type?: string;
          ping_event?: { event_id?: number };
          conversation_initiation_metadata_event?: { conversation_id?: string };
          agent_response_event?: { agent_response?: string };
          agent_response_correction_event?: { corrected_agent_response?: string };
        };
        if (d.type === "ping") sock.send(JSON.stringify({ type: "pong", event_id: d.ping_event?.event_id }));
        else if (d.type === "conversation_initiation_metadata") {
          console.log(`connected (ElevenLabs conversation ${d.conversation_initiation_metadata_event?.conversation_id})`);
          setTimeout(send, 4000); // in case the greeting doesn't arrive as text
        } else if (d.type === "agent_response") {
          const text = String(d.agent_response_event?.agent_response ?? "");
          console.log(`${agent.name} (${((Date.now() - t0) / 1000).toFixed(1)} s): ${text}`);
          if (!sent) return send();
          replies.push(text);
          clearTimeout(grace);
          if (!/^one moment\W*$/i.test(text.trim())) grace = setTimeout(() => finish(), 2500); // wait briefly for more
        } else if (d.type === "agent_response_correction") {
          console.log(`  (corrected: ${d.agent_response_correction_event?.corrected_agent_response})`);
        }
      };
      sock.onerror = () => finish(new Error("WebSocket error"));
      sock.onclose = (e) => finish(replies.length ? undefined : new Error(`ElevenLabs closed the conversation (${e.code} ${e.reason || "no reason"})`));
    }).finally(closeSession);
    console.log("\nWhat the session recorded on our side:");
    for (const p of progressOf(s.sessionId)) console.log(`  ${p.message.replace(/\s+/g, " ").slice(0, 160)}`);
    return;
  }

  if (cmd === "test") {
    // The ElevenLabs dashboard keeps the test values it loaded with the page, so one session (2 hours) serves
    // every test call: reload the agent page once after "ready". Ctrl-C (or SIGTERM) closes it.
    const va = await ready(agent.name, agent.id);
    const s = await startVoice(m, agent, { signedUrl: false, warm: false, test: true });
    await setTestValues(va.elevenAgentId, s.dynamicVariables);
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      setTask(s.sessionId, { status: "done", result: "dashboard test session closed", tokenExpiresAt: new Date().toISOString() });
      await clearTestValues(agent).catch((e) => console.error("could not clear the test values:", (e as Error).message));
    };
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void stop().finally(() => process.exit(130)));
    console.log(`ready: test session ${s.sessionId} is loaded into "Cosign: ${agent.name}" (open until ${s.expiresAt.slice(11, 16)} UTC).`);
    console.log(`Open https://elevenlabs.io/app/agents, pick "Cosign: ${agent.name}", RELOAD the page once (it keeps the values it loaded),`);
    console.log(`then start test calls as often as you like. Turns and tool calls show below. Ctrl-C stops.\n`);
    await follow(s.sessionId, 120, { quietStatus: true });
    await stop();
    return;
  }

  if (cmd === "logs") {
    // ElevenLabs' own record of the last calls: who said what, how long each answer took, and why a call failed
    const va = readConfig().agents[agent.id];
    if (!va) throw new Error(`voice is not set up for ${agent.name}`);
    const n = Math.min(Math.max(Number(rest[0] ?? 1) || 1, 1), 10);
    type Turn = { role: string; message?: string | null; time_in_call_secs?: number; interrupted?: boolean; conversation_turn_metrics?: { metrics?: Record<string, { elapsed_time?: number }> } };
    type Conv = { transcript?: Turn[]; metadata?: { termination_reason?: string | null; error?: unknown; warnings?: unknown[] }; analysis?: { transcript_summary?: string | null } };
    const list = await el<{ conversations: { conversation_id: string; start_time_unix_secs: number; status: string; call_duration_secs: number }[] }>(
      `/v1/convai/conversations?agent_id=${va.elevenAgentId}&page_size=${n}`,
    );
    for (const c of list.conversations.slice(0, n).reverse()) {
      const d = await el<Conv>(`/v1/convai/conversations/${c.conversation_id}`);
      console.log(`\n${new Date(c.start_time_unix_secs * 1000).toISOString()}  ${c.conversation_id}  ${c.status}  ${c.call_duration_secs}s`);
      for (const t of d.transcript ?? []) {
        const m = t.conversation_turn_metrics?.metrics ?? {};
        const sec = (k: string) => (m[k]?.elapsed_time !== undefined ? `${m[k]!.elapsed_time!.toFixed(1)}s` : "");
        const timing = t.role === "agent" && m.convai_llm_service_ttfb ? `  [first sound ${sec("convai_llm_service_ttfb")}, full answer ${sec("convai_llm_service_tt_last_sentence")}]` : "";
        console.log(`  ${String(Math.round(t.time_in_call_secs ?? 0)).padStart(4)}s ${t.role.padEnd(5)} ${String(t.message ?? "").replace(/\s+/g, " ").slice(0, 90)}${timing}${t.interrupted ? "  (interrupted)" : ""}`);
      }
      const why = [d.metadata?.termination_reason, ...(d.metadata?.warnings ?? []).map(String)].filter(Boolean);
      if (why.length) console.log(`  ended: ${why.join("; ")}`);
    }
    return;
  }

  const st = voiceStatus(agent);
  console.log(`${agent.name}: ${st.configured ? `voice ready, ElevenLabs agent ${st.elevenAgentId}, brain ${st.llm}, webhook ${st.webhook}` : "voice not set up (pnpm voice setup)"}`);
  const sessions = db()
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.agentId, agent.id), eq(schema.tasks.kind, "voice")))
    .orderBy(desc(schema.tasks.createdAt))
    .limit(5)
    .all();
  for (const t of sessions) console.log(`  ${t.createdAt}  ${t.status.padEnd(7)}  ${(t.error ?? t.result ?? t.instructions).replace(/\s+/g, " ").slice(0, 90)}`);
})().catch((e) => {
  console.error("FAILED:", e?.message ?? String(e));
  process.exit(1);
});
