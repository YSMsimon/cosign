"use client";

/**
 * A voice call with the agent, for real: Cosign opens a voice session (POST /agents/:id/voice → a signed URL and the
 * session's variables), ElevenLabs does the ears and the mouth, and every turn is answered by the same agent in your
 * own thread (its Custom LLM is our endpoint). The orb's state follows the call; while it works, its step line shows
 * what it has done this turn (from the session's recorded tool calls). Its words show as they are spoken: ElevenLabs
 * sends each chunk of audio with the time of every character, so the caption keeps pace with the voice. Before any
 * audio, the text as it is written stands in (agent_chat_response_part), and the whole answer after that.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useConversation } from "@elevenlabs/react";
import { stillTalking } from "@/lib/voice-pause";
import { api } from "@/lib/client/api";
import { invalidate, useData } from "@/lib/client/data";
import { searchLine, stepLine } from "./steps";

type Progress = { message: string; kind?: string }[];

/** This turn's steps from the session's record: everything after the person last spoke. */
function turnSteps(progress: Progress): string[] {
  const from = progress.findLastIndex((p) => p.message.startsWith("person: "));
  const out: { tool: string; label: string }[] = [];
  for (const p of progress.slice(from + 1)) {
    const m = p.message;
    let x: RegExpExecArray | null;
    if (p.kind === "tool") {
      const tool = m.split(" · ")[0];
      out.push({ tool, label: stepLine(tool, {}, null).label });
    } else if ((x = /^called (\S+)(?: (\{.*\}))?$/.exec(m))) {
      let args: Record<string, unknown> = {};
      try {
        args = x[2] ? (JSON.parse(x[2]) as Record<string, unknown>) : {};
      } catch {
        /* cut off: the label goes without the details */
      }
      out.push({ tool: x[1], label: stepLine(x[1], args, null).label });
    }
    else if ((x = /^searched \((\w+)\): ?(.*)$/.exec(m))) out.push({ tool: x[1], label: searchLine(x[1], x[2]) });
    else if ((x = /^(\S+) (refused|failed): /.exec(m))) {
      const i = out.findLastIndex((o) => o.tool === x![1]);
      if (i >= 0) out[i] = { ...out[i], label: `${out[i].label} · ${x[2]}` };
    }
  }
  return out.map((o) => o.label);
}

export type Phase = "connecting" | "listening" | "thinking" | "talking";

const devLog = (...args: unknown[]) => {
  if (process.env.NODE_ENV !== "production") console.info("[voice]", ...args);
};

export function useVoiceCall(agent: { id: string; name: string } | undefined) {
  const status = useData(agent ? `voice:${agent.id}` : null, () => api.voiceStatus(agent!.id));
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<{ who: "you" | "agent"; text: string; at: number }[]>([]);
  const [steps, setSteps] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState<string | null>(null); // cards for what the agent did in this call
  const [levels, setLevels] = useState<number[]>(Array(20).fill(0));
  const agentId = useRef<string | null>(null);
  // the agent's words this turn: as spoken (timed to the audio), and as written (before the audio catches up)
  const [voiced, setVoiced] = useState("");
  const [written, setWritten] = useState("");
  const due = useRef<{ at: number; ch: string }[]>([]);
  const pump = useRef<ReturnType<typeof setInterval> | null>(null);
  const clearWords = useCallback(() => {
    due.current = [];
    setVoiced("");
    setWritten("");
  }, []);
  // reveal each spoken character at its time in the audio
  const reveal = useCallback((chars: string[], starts: number[]) => {
    const t0 = performance.now();
    chars.forEach((ch, i) => due.current.push({ at: t0 + (starts[i] ?? 0), ch }));
    pump.current ??= setInterval(() => {
      const now = performance.now();
      let add = "";
      while (due.current.length && due.current[0].at <= now) add += due.current.shift()!.ch;
      if (add) setVoiced((v) => v + add);
      if (!due.current.length && pump.current) {
        clearInterval(pump.current);
        pump.current = null;
      }
    }, 50);
  }, []);
  useEffect(() => () => void (pump.current && clearInterval(pump.current)), []);

  const conv = useConversation({ micMuted: muted });
  /*
   * The call's handlers go to startSession, so they belong to the session itself. Passed to the hook instead, they
   * only reach the session if the hook is registered at the moment the call starts, and a page that suspends just
   * then (a new orb loading its texture) drops them for the whole call: it talks, and nothing shows.
   */
  const handlers = useCallback(
    () => ({
    onMessage: (m: { source: string; message: string }) => {
      // "..." or "Um-" is a pause, not a turn: the agent stays quiet, so don't wait for an answer to it
      if (m.source === "user" && stillTalking(m.message)) return;
      if (m.source === "user") {
        // a new turn: its own steps and words
        clearWords();
        setSteps([]);
      }
      setLines((cur) => [...cur, { who: m.source === "user" ? ("you" as const) : ("agent" as const), text: m.message, at: Date.now() }]);
    },
    onAgentChatResponsePart: (p: { text: string; type: "start" | "delta" | "stop" }) => {
      if (p.type === "start") setWritten("");
      else if (p.type === "delta") setWritten((w) => w + p.text);
    },
    onAudioAlignmentPlayback: ({ alignment }: { alignment: { chars: string[]; char_start_times_ms: number[] } }) => reveal(alignment.chars, alignment.char_start_times_ms),
    onInterruption: () => {
      due.current = []; // what it was about to say is cut off
    },
    onError: (message: unknown) => setError(typeof message === "string" ? message : "The call had a problem."),
    // dev only: where a call stops, in the browser console
    onStatusChange: ({ status }: { status: string }) => devLog("status", status),
    onDisconnect: (details: unknown) => devLog("disconnected", details),
    onConnect: ({ conversationId }: { conversationId: string }) => devLog("connected", conversationId),
    }),
    [clearWords, reveal],
  );

  const inCall = starting || conv.status === "connected" || conv.status === "connecting";
  const lastYou = lines.findLast((l) => l.who === "you")?.at ?? 0;
  const lastAgent = lines.findLast((l) => l.who === "agent")?.at ?? 0;
  const phase: Phase = starting || conv.status === "connecting" ? "connecting" : conv.isSpeaking ? "talking" : lastYou > lastAgent ? "thinking" : "listening";

  // while the agent works on a spoken turn, show what it has done so far (the voice session records each tool call)
  useEffect(() => {
    if (!sessionId || phase !== "thinking") return;
    const look = async () => {
      try {
        const { task } = await fetch(`/api/v1/tasks/${sessionId}`).then((r) => r.json() as Promise<{ task: { progress: Progress } }>);
        setSteps(turnSteps(task.progress));
      } catch {
        /* the step line just stays */
      }
    };
    const id = setInterval(look, 900);
    return () => {
      clearInterval(id);
      void look(); // once more as it starts talking: the steps it finished with
    };
  }, [sessionId, phase]);

  // the voice level: the agent's volume while it talks, yours while it listens
  useEffect(() => {
    if (!inCall || (phase !== "talking" && phase !== "listening")) return;
    const id = setInterval(() => {
      const v = phase === "talking" ? conv.getOutputVolume() : muted ? 0 : conv.getInputVolume();
      const amp = Math.min(1, 0.15 + v * 1.6);
      const t = performance.now();
      setLevels(Array.from({ length: 20 }, (_, i) => amp * (0.3 + 0.7 * Math.abs(Math.sin(t / 170 + i * 0.55)))));
    }, 90);
    return () => clearInterval(id);
  }, [inCall, phase, muted, conv]);

  const start = useCallback(async () => {
    if (!agent) return;
    setError(null);
    setLines([]);
    setSteps([]);
    clearWords();
    setStartedAt(new Date().toISOString());
    setMuted(false);
    setStarting(true);
    try {
      const s = await api.startVoice(agent.id);
      invalidate(`voice:${agent.id}`); // a first call may have just set its voice up
      if (!s.signedUrl) throw new Error("ElevenLabs didn't give a signed URL for this call.");
      agentId.current = agent.id;
      setSessionId(s.sessionId);
      conv.startSession({ signedUrl: s.signedUrl, dynamicVariables: s.dynamicVariables, connectionType: "websocket", ...handlers() });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }, [agent, conv, handlers, clearWords]);

  const end = useCallback(() => {
    conv.endSession();
    // what was said is in the thread now (spoken turns are marked Voice)
    if (agentId.current) invalidate(`thread:${agentId.current}`, `agent:${agentId.current}`, "proposals:");
  }, [conv]);

  // a call that ends on its own (the agent hung up, the network dropped) refreshes the thread too
  const was = useRef(conv.status);
  useEffect(() => {
    if (was.current === "connected" && conv.status === "disconnected" && agentId.current) invalidate(`thread:${agentId.current}`);
    was.current = conv.status;
  }, [conv.status]);

  const caption = lines.at(-1)?.text ?? null;
  const asked = lines.findLast((l) => l.who === "you")?.text ?? null;
  // its words this turn: as spoken if the audio carries timings, else as written, else the last whole answer
  const said = voiced.trim() || written.trim() || (lastAgent > lastYou ? (lines.findLast((l) => l.who === "agent")?.text ?? null) : null);
  const statusText =
    phase === "connecting"
      ? `Connecting to ${agent?.name}...`
      : phase === "thinking"
        ? steps.length
          ? `${steps.at(-1)}…`
          : "Thinking..."
        : phase === "talking"
          ? `${agent?.name} is talking`
          : muted
            ? "Muted"
            : "Listening";

  // Talk shows when the agent has a voice, or will get one on its first call
  return { configured: !!status.data?.configured || !!(status.data as { ready?: boolean } | undefined)?.ready, inCall, phase, statusText, caption, asked, said, steps, levels, muted, setMuted, start, end, error, clearError: () => setError(null), sessionId, lines, startedAt };
}
