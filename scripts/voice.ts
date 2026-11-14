/**
 * ElevenLabs voice for a demo agent, from the terminal (acts as the Test CFO, like pnpm grokbot).
 *
 *   pnpm voice setup [agent]    create or update "Cosign: <agent>" on ElevenLabs: its tools, the post-call webhook, the agent
 *   pnpm voice test [agent]     open a voice session and load it into that agent's test values, then talk to it with the
 *                               ElevenLabs dashboard's test call; tool calls show here live, and the session closes when the call ends
 *   pnpm voice status [agent]
 *
 * [agent] is an agent name in the demo workspace (default: Clerk). Needs ELEVENLABS_API_KEY in .env.local, `pnpm dev`,
 * and a public URL (PUBLIC_BASE_URL or a running ngrok tunnel). Run setup again whenever the public URL changes.
 */
import { desc, eq, and } from "drizzle-orm";
import { db, schema } from "../src/lib/db";
import { setTask } from "../src/lib/server/grokbot";
import { clearTestValues, readConfig, setTestValues, setupVoice, startVoice, voiceStatus } from "../src/lib/server/voice";
import { checkReachable, demo, follow, publicBase } from "./lib/demo";

(async () => {
  const [cmd = "status", agentName = "Clerk"] = process.argv.slice(2);
  const { m, ws, agent } = demo(agentName);

  if (cmd === "setup") {
    if (!process.env.ELEVENLABS_API_KEY) throw new Error("add ELEVENLABS_API_KEY to .env.local first (ElevenLabs → Developers → API keys)");
    const base = await publicBase();
    await checkReachable(base);
    console.log(`Setting up "Cosign: ${agent.name}" on ElevenLabs; its tools and webhook point at ${base}`);
    const r = await setupVoice(agent, ws, base, (s) => console.log(`  · ${s}`));
    console.log(`\nREADY: ElevenLabs agent ${r.elevenAgentId}. Next: pnpm voice test ${agent.name}`);
    return;
  }

  if (cmd === "test") {
    const cfg = readConfig();
    const va = cfg.agents[agent.id];
    if (!va) throw new Error(`voice is not set up for ${agent.name}; run pnpm voice setup ${agent.name}`);
    const base = await publicBase();
    if (cfg.base !== base) throw new Error(`the public URL changed (${cfg.base} → ${base}); run pnpm voice setup ${agent.name} again`);
    await checkReachable(base);
    const s = await startVoice(m, agent, { signedUrl: false });
    await setTestValues(va.elevenAgentId, s.dynamicVariables);
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      // the token dies now; the post-call webhook can still close the session with its transcript
      setTask(s.sessionId, { tokenExpiresAt: new Date().toISOString() });
      await clearTestValues(agent, ws).catch((e) => console.error("could not clear the test values:", (e as Error).message));
    };
    process.on("SIGINT", () => void finish().finally(() => process.exit(130)));
    console.log(`Voice session ${s.sessionId} (until ${s.expiresAt}) is loaded into the test values of "Cosign: ${agent.name}".`);
    console.log(`Open https://elevenlabs.io/app/agents, pick "Cosign: ${agent.name}", and start its test call.`);
    console.log(`Try: "What's waiting for a cosign?" Tool calls show below; the session closes when the call ends. Ctrl-C stops.\n`);
    await follow(s.sessionId, 30, { quietStatus: true });
    await finish();
    return;
  }

  const st = voiceStatus(agent);
  console.log(`${agent.name} (${ws.name}): ${st.configured ? `voice ready, ElevenLabs agent ${st.elevenAgentId}, webhook ${st.webhook}` : "voice not set up (pnpm voice setup)"}`);
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
