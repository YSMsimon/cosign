import { resolve } from "node:path";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { pageApi, personFromKey, readState, signInThroughUi } from "./shared";
import { clipPath, ensureClips, VOICE_CASES } from "./voice-setup";

/**
 * One real call, several spoken questions, one per kind of tool (and a funding request, whose card opens in the call): each recorded question is played into the call's
 * microphone when the agent has finished the last answer. Checks the tool each one used (from the thread), the
 * approval row a spoken draft opens, and times every turn: when your words were understood, when the agent's first
 * words came, when its answer was done, and on the server where the time went (each Grok call, each tool).
 * Opt-in (VOICE_TOOLS=1): it is a real ElevenLabs call of a couple of minutes.
 */
test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });
test.skip(!process.env.VOICE_TOOLS, "set VOICE_TOOLS=1 to run the spoken tool test (a real ElevenLabs call)");

type Thread = { messages: { kind: string; name?: string; text?: string; via?: string; t: string }[] };

/** A microphone that is silent until the test plays a recorded question into it (window.__cosignSay). */
async function playableMicrophone(page: Page) {
  await page.route("**/__test/voice/*.wav", (r) => {
    const id = r.request().url().split("/").pop()!.replace(".wav", "");
    return r.fulfill({ body: readFileSync(resolve(clipPath(id))), contentType: "audio/wav" });
  });
  await page.addInitScript(() => {
    const md = navigator.mediaDevices;
    if (!md) return;
    const w = window as unknown as { __cosignSay?: (id: string) => Promise<number> };
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      if (!c?.audio) throw new DOMException("only a microphone here", "NotFoundError");
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      w.__cosignSay = async (id: string) => {
        const buf = await ctx.decodeAudioData(await fetch(`/__test/voice/${id}.wav`).then((r) => r.arrayBuffer()));
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(dest);
        src.start();
        return buf.duration;
      };
      return dest.stream;
    };
  });
}

/** Where each voice turn's time went on our server, from the run logs: each Grok call and each tool. */
function serverTurns(since: number) {
  const dir = resolve("logs/runs", new Date().toISOString().slice(0, 10));
  const runs: { prompt: string; total: number; model: number[]; tools: string[] }[] = [];
  for (const f of readdirSync(dir)) {
    const path = resolve(dir, f);
    if (statSync(path).mtimeMs < since) continue;
    const ev = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown> & { type: string; ms: number });
    const start = ev.find((e) => e.type === "run_start");
    if (!start || Date.parse(String(start.t)) < since) continue;
    const model: number[] = [];
    let req = 0;
    for (const e of ev) {
      if (e.type === "model_request") req = e.ms;
      if (e.type === "model_response") model.push((e.ms - req) / 1000);
    }
    const tools = ev.filter((e) => e.type === "tool_result" || e.type === "tool_error" || e.type === "policy_refused").map((e) => `${e.tool} ${((Number(e.durationMs) || 0) / 1000).toFixed(1)}s`);
    runs.push({ prompt: String(start.prompt), total: (ev.at(-1)?.ms ?? 0) / 1000, model, tools });
  }
  return runs;
}

test("voice, one call: each spoken question uses its tool, a spoken draft opens its approval row, and every turn is timed", async ({ page }) => {
  test.setTimeout(420_000);
  ensureClips();
  const s = readState();
  const owner = personFromKey("owner", s.ownerKey);
  await playableMicrophone(page);
  await signInThroughUi(page, owner.account);
  await page.goto(`/chat?agent=${s.agent}`);
  const ready = await pageApi<{ configured: boolean }>(page, "GET", `/agents/${s.agent}/voice`);
  test.skip(!ready.json.configured, "voice isn't set up for the test agent (see global-setup)");
  const since = Date.now();

  await page.getByRole("button", { name: "Talk" }).click();
  await expect(page.getByText(/Hi, it.s Clerk/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Listening")).toBeVisible({ timeout: 30_000 });

  const caption = page.locator('[aria-live="polite"]').last();
  const rows: Record<string, string | number | null>[] = [];
  for (const c of VOICE_CASES) {
    const before = (await pageApi<Thread>(page, "GET", `/agents/${s.agent}/thread`)).json.messages.length;
    const youBefore = await page.getByText(/^You · /).textContent({ timeout: 500 }).catch(() => null);
    const t0 = Date.now();
    const secs = await page.evaluate((id) => (window as unknown as { __cosignSay: (id: string) => Promise<number> }).__cosignSay(id), c.id);
    const spokenEnd = t0 + secs * 1000;
    // your words understood ("You · …"), the agent's first words on screen (they keep pace with its voice), its answer done
    let heard: number | null = null;
    let first: number | null = null;
    const until = Date.now() + 90_000;
    while (Date.now() < until && first === null) {
      const you = await page.getByText(/^You · /).textContent({ timeout: 200 }).catch(() => null);
      if (heard === null && you && you !== youBefore) heard = Date.now();
      if (heard !== null && ((await caption.textContent().catch(() => "")) ?? "").trim()) first = Date.now();
      await page.waitForTimeout(100);
    }
    // the turn is saved when the answer is complete: its tools come from the thread
    let tools: string[] = [];
    let answer = "";
    await expect
      .poll(
        async () => {
          const m = (await pageApi<Thread>(page, "GET", `/agents/${s.agent}/thread`)).json.messages.slice(before);
          const asked = m.findIndex((x) => x.kind === "user" && x.via === "voice");
          const said = m.findLastIndex((x) => x.kind === "assistant" && x.via === "voice");
          tools = m.slice(asked + 1).filter((x) => x.kind === "tool").map((x) => x.name ?? "");
          answer = said > asked ? (m[said].text ?? "") : "";
          return asked >= 0 && said > asked;
        },
        { timeout: 120_000, intervals: [1000] },
      )
      .toBe(true);
    const saved = Date.now();
    if (c.tool) expect(tools, `"${c.text}" should use ${c.tool}`).toContain(c.tool);
    if (c.id === "draft") await expect(page.getByText(/Approve \$0\.1/).first()).toBeVisible({ timeout: 30_000 });
    if (c.id === "funds") await expect(page.getByText(/Add \$5(\.00)? to the treasury\?/).first()).toBeVisible({ timeout: 30_000 });
    // PEEK_DIR: the call view after each answer (the words, the step line, any card it opened)
    if (process.env.PEEK_DIR) await page.screenshot({ path: `${process.env.PEEK_DIR}/voice-${String(rows.length + 1).padStart(2, "0")}-${c.id}.png` });
    // wait for it to finish speaking before the next question
    await expect(page.getByText("Listening")).toBeVisible({ timeout: 60_000 });
    rows.push({
      case: c.id,
      tools: tools.join(", ") || "none",
      understood: heard ? +((heard - spokenEnd) / 1000).toFixed(1) : null,
      firstWords: first ? +((first - spokenEnd) / 1000).toFixed(1) : null,
      answerSaved: +((saved - spokenEnd) / 1000).toFixed(1),
      answer: answer.slice(0, 90),
    });
    await page.waitForTimeout(1500);
  }

  await page.getByRole("button", { name: "End call" }).click();
  const server = serverTurns(since);
  const report = { rows, server };
  writeFileSync("node_modules/.cosign-tmp/voice-timings.json", JSON.stringify(report, null, 2));
  console.log("\nseconds after each question finished:");
  console.table(rows);
  console.log("server, per turn (Grok calls in s, tools):");
  for (const r of server) console.log(`  ${r.total.toFixed(1)}s  model ${r.model.map((x) => x.toFixed(1)).join(" + ")}  tools ${r.tools.join(", ") || "none"}  · ${r.prompt.slice(0, 50)}`);
});
