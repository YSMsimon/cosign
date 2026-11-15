"use client";

/**
 * A voice call with the agent, for real: Cosign opens a voice session (POST /agents/:id/voice → a signed URL and the
 * session's variables), ElevenLabs does the ears and the mouth, and every turn is answered by the same agent in your
 * own thread (its Custom LLM is our endpoint). The orb's state follows the call; while it works, its status line is
 * the step the agent is on (from the session's recorded tool calls).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useConversation } from "@elevenlabs/react";
import { api } from "@/lib/client/api";
import { invalidate, useData } from "@/lib/client/data";
import { stepLine } from "./steps";

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
  const [working, setWorking] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>(Array(20).fill(0));
  const agentId = useRef<string | null>(null);

  const conv = useConversation({
    micMuted: muted,
    onMessage: (m) => setLines((cur) => [...cur, { who: m.source === "user" ? "you" : "agent", text: m.message, at: Date.now() }]),
    onError: (message) => setError(typeof message === "string" ? message : "The call had a problem."),
    // dev only: where a call stops, in the browser console
    onStatusChange: ({ status }) => devLog("status", status),
    onDisconnect: (details) => devLog("disconnected", details),
    onConnect: ({ conversationId }) => devLog("connected", conversationId),
  });

  const inCall = starting || conv.status === "connected" || conv.status === "connecting";
  const lastYou = lines.findLast((l) => l.who === "you")?.at ?? 0;
  const lastAgent = lines.findLast((l) => l.who === "agent")?.at ?? 0;
  const phase: Phase = starting || conv.status === "connecting" ? "connecting" : conv.isSpeaking ? "talking" : lastYou > lastAgent ? "thinking" : "listening";

  // while the agent works on a spoken turn, show the step it is on (the voice session records each tool call)
  useEffect(() => {
    if (!sessionId || phase !== "thinking") return;
    const id = setInterval(async () => {
      try {
        const { task } = await fetch(`/api/v1/tasks/${sessionId}`).then((r) => r.json() as Promise<{ task: { progress: { message: string; kind?: string }[] } }>);
        const last = task.progress.filter((p) => p.kind === "tool").at(-1)?.message;
        if (last) setWorking(`${stepLine(last.split(" · ")[0], {}, null).label}…`);
      } catch {
        /* the status line just stays */
      }
    }, 900);
    return () => clearInterval(id);
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
    setWorking(null);
    setMuted(false);
    setStarting(true);
    try {
      const s = await api.startVoice(agent.id);
      if (!s.signedUrl) throw new Error("ElevenLabs didn't give a signed URL for this call.");
      agentId.current = agent.id;
      setSessionId(s.sessionId);
      conv.startSession({ signedUrl: s.signedUrl, dynamicVariables: s.dynamicVariables, connectionType: "websocket" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }, [agent, conv]);

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
  const statusText =
    phase === "connecting"
      ? `Connecting to ${agent?.name}...`
      : phase === "thinking"
        ? (working ?? "Thinking...")
        : phase === "talking"
          ? `${agent?.name} is talking`
          : muted
            ? "Muted"
            : "Listening";

  return { configured: !!status.data?.configured, inCall, phase, statusText, caption, levels, muted, setMuted, start, end, error, clearError: () => setError(null), sessionId, lines };
}
