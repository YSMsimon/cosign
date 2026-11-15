"use client";

/**
 * The rooms with your real workspace in them. Rooms themselves (names, guidelines, who is in) are still kept in the
 * browser, as on the design board, but the people and agents in them are real: a room's agents are your agents and its
 * people are the workspace's members. A room saved with the board's sample names (clerk, priya, …) keeps whoever has
 * that name here; anyone without a real match is left out.
 */
import { useMemo } from "react";
import type { Team } from "@/lib/client/api";
import { shortAddr } from "@/lib/client/wallet";
import type { Agent } from "../../mockups/v2/agents";
import { ME } from "../../mockups/v2/rooms";
import type { Room, Teammate } from "../../mockups/v2/store";
import { initialsOf } from "../app-shell";

export function useRealRooms(o: {
  rooms: Room[];
  agents: Agent[];
  people: Team["people"] | undefined;
  address: string;
  sample: { agents: Agent[]; team: Teammate[] };
}): { rooms: Room[]; agents: Agent[]; team: Teammate[] } {
  const { rooms, agents, people, address, sample } = o;
  return useMemo(() => {
    // you are ME (how rooms remember that you joined); everyone else by their member id
    const team: Teammate[] = (people ?? []).map((p) => {
      const you = p.address.toLowerCase() === address;
      return { id: you ? ME : p.id, name: p.name, initials: initialsOf(p.name, p.address), wallet: shortAddr(p.address), address: p.address, role: p.role, you };
    });
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    const resolve = (id: string): string | null => {
      if (id === ME || agents.some((a) => a.id === id) || team.some((t) => t.id === id)) return id;
      const sa = sample.agents.find((a) => a.id === id);
      if (sa) return agents.find((a) => same(a.name, sa.name))?.id ?? null;
      const st = sample.team.find((t) => t.id === id && !t.you);
      if (st) return team.find((t) => !t.you && same(t.name, st.name))?.id ?? null;
      return null;
    };
    const real = rooms.map((r) => ({ ...r, members: [...new Set(r.members.map(resolve).filter((x): x is string => !!x))] }));
    return { rooms: real, agents, team };
  }, [rooms, agents, people, address, sample.agents, sample.team]);
}
