"use client";

/**
 * Asking in a room, for real. Rooms themselves are still the design board's sample, but an agent named in a room is
 * your real agent of that name: it answers in this room's own thread with you (apart from your one-to-one chat; its
 * memory and files are shared),
 * and the room shows its steps and its words as they stream in. "@Grok Bot …" starts a real background job for the
 * agent it names (or the room's first agent), and the room follows the job until Grok Bot reports back.
 */
import { useCallback } from "react";
import { api, chatTurn, type Task } from "@/lib/client/api";
import { invalidate } from "@/lib/client/data";
import type { RoomAsk, RoomReply } from "../../mockups/v2/room-view";
import { useAgentsData } from "../agents-data";
import { useCosign } from "../cosign";
import { STATUS } from "./extras";
import { foldRunEvent, turnTitle, type LiveStep } from "./steps";

const JOB_WAIT_MS = 15 * 60_000; // follow a job in the room this long; its result also lands in the agent's chat
const POLL_MS = 2000;
const short = (s: string) => (s.length > 70 ? `${s.slice(0, 67)}…` : s);

/** A Grok Bot job as the room shows it: its status and instructions, then its notes and tool calls, then its result. */
function jobReply(t: Task, agentName: string): RoomReply {
  const running = !["done", "failed"].includes(t.status);
  const notes = t.progress.filter((p) => p.kind !== "tool").map((p) => p.message);
  const tools = t.progress.filter((p) => p.kind === "tool").map((p) => p.message);
  return {
    title: `${STATUS[t.status] ?? t.status} · ${short(t.instructions)}`,
    steps: [...notes, ...tools],
    text: t.result ?? undefined,
    error: t.status === "failed" ? `Couldn't finish: ${t.error ?? "the job failed"}` : undefined,
    running,
    by: t.engine === "grokbot" ? undefined : agentName,
  };
}

export function useRoomAsk(): RoomAsk {
  const { wsId } = useCosign();
  const { usable } = useAgentsData();

  return useCallback<RoomAsk>(
    async (to, text, room, update) => {
      const byName = (name: string) => usable.find((a) => a.name.toLowerCase() === name.toLowerCase());

      if (to.kind === "agent") {
        const agent = byName(to.name);
        if (!agent) return { title: "Not asked", steps: [], running: false, error: `None of the agents you can use is called ${to.name}.` };
        const note = `This message was sent in the #${room.name} room, where other people and agents read your answer.${room.guidelines ? ` The room's guidelines: ${room.guidelines}` : ""}`;
        const startedAt = Date.now();
        let cur: { steps: LiveStep[]; text?: string } = { steps: [] };
        const now = (running: boolean): RoomReply => ({
          title: running ? (cur.steps.at(-1)?.label ?? "Thinking") : turnTitle(cur.steps.length, Date.now() - startedAt),
          steps: cur.steps.map((s) => s.label),
          text: cur.text || undefined,
          running,
        });
        try {
          const done = await chatTurn(agent.id, text, (s) => {
            cur = foldRunEvent(cur, s);
            update(now(true));
          }, undefined, note, room.id);
          cur = { ...cur, text: done.finalText };
          // what it drafted: the room shows each payment's approval card under the answer
          const proposals = cur.steps
            .filter((s) => s.name === "propose_payment")
            .map((s) => (s.result as { proposalId?: unknown } | undefined)?.proposalId)
            .filter((x): x is string | number => x !== undefined && x !== null)
            .map(String);
          return { ...now(false), ...(proposals.length ? { proposals } : {}) };
        } catch (e) {
          return { ...now(false), error: (e as Error).message };
        } finally {
          // what it did may show elsewhere (a draft's card, its balance)
          invalidate(`agent:${agent.id}`, "proposals:", "approvals:", "funding:", "spend:", "tasks:");
        }
      }

      const agent = to.agents.map(byName).find((a) => !!a);
      if (!agent) return { title: "Not started", steps: [], running: false, error: "Grok Bot works for one of your agents: name one, or add one to this room." };
      const job = text.replace(/@Grok Bot\b/gi, "").trim() || text;
      let { task } = await api.startTask(agent.id, job);
      invalidate(`tasks:${wsId}`);
      const until = Date.now() + JOB_WAIT_MS;
      for (;;) {
        const r = jobReply(task, agent.name);
        if (!r.running) {
          invalidate(`tasks:${wsId}`, "proposals:", "team-messages:");
          return r;
        }
        update(r);
        if (Date.now() > until) return { ...r, running: false, error: `Still working. Its result will show in your chat with ${agent.name}.` };
        await new Promise((ok) => setTimeout(ok, POLL_MS));
        try {
          task = (await api.task(task.id)).task;
        } catch {
          /* a missed look is fine: try again on the next one */
        }
      }
    },
    [usable, wsId],
  );
}
