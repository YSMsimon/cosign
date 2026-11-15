"use client";

/** The workspace's agents as the screens draw them (the design boards' Agent shape), from the real API. */
import { useMemo } from "react";
import type { OrbHue } from "@/components/orb-avatar";
import { api, type AgentDetail, type AgentView, type Task, type WorkspaceDetail } from "@/lib/client/api";
import { useData } from "@/lib/client/data";
import type { AboutInfo } from "../mockups/v2/agent-about";
import type { Agent } from "../mockups/v2/agents";
import { useCosign } from "./cosign";

export const HUES: OrbHue[] = ["violet", "pink", "orange", "blue", "teal"];

/** Its saved orb colour; agents made before colours were saved get a steady one from their id. */
export function hueOf(a: { id: string; hue?: string | null }): OrbHue {
  if (a.hue && (HUES as string[]).includes(a.hue)) return a.hue as OrbHue;
  let h = 0;
  for (const ch of a.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

/** "What it does", first sentence, short enough for a list row. */
export function jobOf(prompt: string) {
  const first = prompt.split(/(?<=[.!?])\s/)[0].trim();
  return first.length > 64 ? `${first.slice(0, 61)}…` : first || "Agent";
}

const RUNNING = new Set(["queued", "sent", "acked", "working"]);

/** The design boards' Agent: working when one of its jobs is running, with what that job is. */
export function toAgent(a: AgentView, tasks: Task[]): Agent {
  const job = tasks.find((t) => t.agentId === a.id && RUNNING.has(t.status) && t.kind !== "voice");
  return {
    id: a.id,
    name: a.name,
    hue: hueOf(a),
    job: jobOf(a.prompt),
    online: !!job,
    now: job ? (job.instructions.length > 40 ? `${job.instructions.slice(0, 37)}…` : job.instructions) : jobOf(a.prompt),
  };
}

/** Agents you can see and their running jobs; `usable` are the ones you can talk to. */
export function useAgentsData() {
  const { wsId } = useCosign();
  const agents = useData(`agents:${wsId}`, () => api.agents(wsId));
  const tasks = useData(`tasks:${wsId}`, () => api.tasks(wsId));
  // the same arrays until the data changes, so lists built from them (the @ list) stay put between renders
  const shaped = useMemo(() => {
    const list = (agents.data?.agents ?? []).filter((a) => a.status === "active");
    const t = tasks.data?.tasks ?? [];
    return { views: list, usable: list.filter((a) => a.you.canUse).map((a) => toAgent(a, t)), all: list.map((a) => toAgent(a, t)), tasks: t };
  }, [agents.data, tasks.data]);
  return { loading: agents.loading, error: agents.error, reload: agents.reload, ...shaped };
}

/** What the agent panel in the chat shows: its wallet and its place on the treasury. */
export function aboutInfo(d: AgentDetail | undefined, ws: WorkspaceDetail, fallbackWallet: string): AboutInfo {
  const ab = d?.abilities;
  const can = ab ? [ab.buy && "Spend from its wallet", ab.draft && "Draft payments", ab.pettyCash && "Petty cash"].filter(Boolean).join(" · ") || "No money" : "…";
  const perWeek = d?.onchain.pettyCashPerWeekUsd ?? 0;
  const left = Number(d?.onchain.pettyCashLeftUsd ?? 0);
  return {
    wallet: d?.wallet ?? fallbackWallet,
    usdc: d ? Number(d.balances.walletUsdc) : null,
    can,
    treasury: { address: ws.treasury.address, threshold: ws.treasury.threshold, approvers: ws.treasury.approvers.length, usdc: Number(ws.treasury.balanceUsd) },
    pettyCash: ab?.pettyCash && perWeek > 0 ? { perWeek, used: Math.max(0, perWeek - left) } : null,
  };
}
