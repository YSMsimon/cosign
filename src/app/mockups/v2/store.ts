"use client";

/**
 * Prototype state for the mockups: agents and each agent's extra messages live in the browser (localStorage),
 * so what you create, delete or say carries across pages and survives a refresh. No backend. Reset by clearing
 * the site's storage (or calling `resetMockData()` from the console).
 */
import { useSyncExternalStore } from "react";
import type { Agent } from "./agents";
import { team } from "./parts";

/** One message. In a room, `author` says which teammate or agent said it (`who: "person"` is a teammate other than you). */
export type Line = { who: "you" | "agent" | "person"; text: string; via?: "voice"; files?: string[]; author?: string };

/** A person in the workspace. They sign in with their wallet; `invited` until they first do. */
export type Teammate = { id: string; name: string; initials: string; wallet: string; address?: string; role: string; you?: boolean; invited?: boolean };

/** A room: a shared conversation for people and agents. Public rooms anyone in the workspace can find and join. */
export type Room = {
  id: string;
  name: string;
  visibility: "public" | "private";
  guidelines: string;
  /** teammate and agent ids */
  members: string[];
};

/** Lines of a room are stored next to agents' lines, under this key. */
export const roomKey = (id: string) => `room:${id}`;

const DEFAULT_AGENTS: Agent[] = team.map(({ id, name, hue, job, online, now }) => ({ id, name, hue, job, online, now }));
const DEFAULT_LINES: Record<string, Line[]> = {};

const DEFAULT_TEAM: Teammate[] = [
  { id: "simon", name: "Simon", initials: "SY", wallet: "0x8f2c…41aa", address: "0x8f2c5d1e9b7a3c6f0e4d2b8a1c9e7f5d3b2a41aa", role: "Owner", you: true },
  { id: "priya", name: "Priya", initials: "PR", wallet: "0x51d0…9c3e", address: "0x51d044bcff24eb6751fdcc80626affe0ad389c3e", role: "Approver" },
  { id: "jordan", name: "Jordan", initials: "JO", wallet: "0xa77e…02b1", address: "0xa77e136c67657614311f32238751044a0a3c02b1", role: "Member" },
  { id: "sam", name: "Sam", initials: "SA", wallet: "0x3b19…d4f0", address: "0x3b19e96e02d8e47f2a7c03be5117b3ed175cd4f0", role: "Viewer" },
];

const DEFAULT_ROOMS: Room[] = [
  {
    id: "finance",
    name: "finance",
    visibility: "public",
    guidelines: "Invoices and payments. Agents draft; Priya or Simon approves.",
    members: ["simon", "priya", "clerk", "auditor"],
  },
  {
    id: "payroll",
    name: "payroll",
    visibility: "private",
    guidelines: "Contractor pay every Friday. Only Simon and Clerk.",
    members: ["simon", "clerk"],
  },
  {
    id: "ops",
    name: "ops",
    visibility: "public",
    guidelines: "Tools, subscriptions and the books.",
    members: ["jordan", "sam", "scribe"],
  },
];

function createStore<T>(key: string, fallback: T) {
  let cache: T | undefined;
  const listeners = new Set<() => void>();
  const read = (): T => {
    if (cache !== undefined) return cache;
    try {
      const raw = localStorage.getItem(key);
      cache = raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      cache = fallback;
    }
    return cache;
  };
  const write = (next: T) => {
    cache = next;
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* private window or blocked storage: keep it in memory for this visit */
    }
    for (const l of listeners) l();
  };
  const subscribe = (cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };
  const use = () => useSyncExternalStore(subscribe, read, () => fallback);
  return { read, write, use };
}

const agentsStore = createStore<Agent[]>("cosign-mock-agents", DEFAULT_AGENTS);
const linesStore = createStore<Record<string, Line[]>>("cosign-mock-lines", DEFAULT_LINES);
const roomsStore = createStore<Room[]>("cosign-mock-rooms", DEFAULT_ROOMS);
const teamStore = createStore<Teammate[]>("cosign-mock-team", DEFAULT_TEAM);

export function useAgents() {
  const agents = agentsStore.use();
  return {
    agents,
    add: (a: Agent) => agentsStore.write([...agentsStore.read(), a]),
    remove: (id: string) => agentsStore.write(agentsStore.read().filter((a) => a.id !== id)),
  };
}

/** Messages said to (and by) each agent beyond the built-in sample conversation, typed or spoken. */
export function useLines() {
  const lines = linesStore.use();
  return {
    lines,
    say: (agentId: string, line: Line) => {
      const all = linesStore.read();
      linesStore.write({ ...all, [agentId]: [...(all[agentId] ?? []), line] });
    },
  };
}

export function useRooms() {
  const rooms = roomsStore.use();
  return {
    rooms,
    add: (r: Room) => roomsStore.write([...roomsStore.read(), r]),
    /** add people or agents to a room (joining a public room adds yourself) */
    addMembers: (id: string, ids: string[]) =>
      roomsStore.write(roomsStore.read().map((r) => (r.id === id ? { ...r, members: [...new Set([...r.members, ...ids])] } : r))),
  };
}

export function useTeam() {
  const team = teamStore.use();
  return {
    team,
    invite: (t: Teammate) => teamStore.write([...teamStore.read(), t]),
  };
}

export function resetMockData() {
  agentsStore.write(DEFAULT_AGENTS);
  linesStore.write(DEFAULT_LINES);
  roomsStore.write(DEFAULT_ROOMS);
  teamStore.write(DEFAULT_TEAM);
}

if (typeof window !== "undefined") (window as unknown as { resetMockData?: () => void }).resetMockData = resetMockData;
