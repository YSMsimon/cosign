import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { pageApi, personFromKey, readState, signInThroughUi } from "./shared";
import { QUESTION_WAV } from "./voice-setup";

type Thread = { messages: { kind: string; text?: string; via?: string; t: string }[] };

// Chrome launched from a terminal on macOS can't open even a fake microphone (the system's permission prompt has
// nowhere to show), so the test hands the page a microphone of its own: one spoken question, after a pause for the
// greeting, played into a MediaStream. Test-only, like the wallet; the app calls getUserMedia as usual.
test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

async function fakeMicrophone(page: Page) {
  await page.route("**/__test/voice-question.wav", (r) => r.fulfill({ body: readFileSync(resolve(QUESTION_WAV)), contentType: "audio/wav" }));
  await page.addInitScript(() => {
    const md = navigator.mediaDevices;
    if (!md) return;
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      if (!c?.audio) throw new DOMException("only a microphone here", "NotFoundError");
      const ctx = new AudioContext();
      const data = await fetch("/__test/voice-question.wav").then((r) => r.arrayBuffer());
      const buf = await ctx.decodeAudioData(data);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const dest = ctx.createMediaStreamDestination();
      src.connect(dest);
      src.start(ctx.currentTime + 0.2);
      return dest.stream;
    };
  });
}

test("voice: a real ElevenLabs call with the agent; the spoken turn is answered by Cosign and lands in the thread", async ({ page }) => {
  test.skip(!process.env.ELEVENLABS_API_KEY, "no ElevenLabs key");
  test.setTimeout(240_000);
  const s = readState();
  const owner = personFromKey("owner", s.ownerKey);
  await fakeMicrophone(page);
  await signInThroughUi(page, owner.account);
  await page.goto(`/chat?agent=${s.agent}`);
  const ready = await pageApi<{ configured: boolean }>(page, "GET", `/agents/${s.agent}/voice`);
  test.skip(!ready.json.configured, "voice isn't set up for the test agent (see global-setup)");
  const startedAt = new Date().toISOString();

  // Talk: the call opens on the agent's orb and it greets you
  await page.getByRole("button", { name: "Talk" }).click();
  await expect(page.getByText("In a call")).toBeVisible();
  await expect(page.getByText(/Hi, it.s Clerk/)).toBeVisible({ timeout: 60_000 });

  // what you said shows over the agent's words (the call's caption); PEEK_DIR saves a frame a second to look at
  const peek = process.env.PEEK_DIR;
  const frames = peek
    ? (async () => {
        for (let i = 0; i < 30 && !page.isClosed(); i++) {
          await page.screenshot({ path: `${peek}/call-${String(i).padStart(2, "0")}.png` }).catch(() => {});
          await page.waitForTimeout(1000);
        }
      })()
    : Promise.resolve();
  await expect(page.getByText(/^You · /)).toBeVisible({ timeout: 90_000 });

  // the question from the microphone becomes a spoken turn in your thread, answered by the same agent
  await expect
    .poll(
      async () => {
        const t = await pageApi<Thread>(page, "GET", `/agents/${s.agent}/thread`);
        const asked = t.json.messages.findIndex((m) => m.kind === "user" && m.via === "voice" && m.t > startedAt);
        return asked >= 0 && t.json.messages.slice(asked).some((m) => m.kind === "assistant" && m.via === "voice" && (m.text ?? "").length > 0);
      },
      { timeout: 150_000, intervals: [2000] },
    )
    .toBe(true);

  await frames;
  // End call: back to the conversation, where the spoken turns carry the Voice tag
  await page.getByRole("button", { name: "End call" }).click();
  await expect(page.getByPlaceholder("Message Clerk")).toBeVisible();
  await expect(page.getByText("Voice", { exact: true }).last()).toBeVisible({ timeout: 30_000 });
});
