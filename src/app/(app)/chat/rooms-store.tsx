"use client";

/**
 * Rooms on the server, as the room screens expect them (server/rooms.ts). Everyone in a room sees the same lines: the
 * room looks again every 2 s while it's open, so a teammate's message or an agent's answer shows up in every window.
 * A background job that belongs to the room (Grok Bot checking a payment drafted there) is drawn as the job itself,
 * the same view the one-to-one chat uses.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type RoomLineData } from "@/lib/client/api";
import { invalidate, useData } from "@/lib/client/data";
import { useCosign } from "../cosign";
import { useAgentsData } from "../agents-data";
import type { Agent } from "../../mockups/v2/agents";
import { GROK_BOT } from "../../mockups/v2/mentions";
import { RoomView, type RoomAsk, type RoomStore } from "../../mockups/v2/room-view";
import { ME } from "../../mockups/v2/rooms";
import type { Line, Room, Teammate } from "../../mockups/v2/store";
import type { Picked } from "../../mockups/v2/composer";
import { ToolCard } from "./cards";
import { JobView } from "./extras";

const LINES_POLL_MS = 2000;
const ROOMS_POLL_MS = 5000;

/** The workspace's rooms you can see. In a room's members you are ME (how the room screens know you're in it). */
export function useServerRooms() {
  const { wsId, ws } = useCosign();
  const me = ws.me.memberId;
  const data = useData(`rooms:${wsId}`, () => api.rooms(wsId));
  useEffect(() => {
    const id = setInterval(() => invalidate(`rooms:${wsId}`), ROOMS_POLL_MS);
    return () => clearInterval(id);
  }, [wsId]);
  const rooms: Room[] = useMemo(
    () =>
      (data.data?.rooms ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        visibility: r.visibility,
        guidelines: r.guidelines,
        members: r.members.map((x) => (x === me ? ME : x)),
      })),
    [data.data, me],
  );
  const toServer = useCallback((ids: string[]) => ids.map((x) => (x === ME ? me : x)).filter((x): x is string => !!x), [me]);
  return {
    rooms,
    /** make a room; resolves to its id (the server picks it) */
    add: async (r: Room) => {
      const { room } = await api.createRoom(wsId, { name: r.name, visibility: r.visibility, guidelines: r.guidelines, members: toServer(r.members) });
      invalidate(`rooms:${wsId}`);
      return room.id;
    },
    addMembers: async (id: string, ids: string[]) => {
      await api.addRoomMembers(wsId, id, toServer(ids));
      invalidate(`rooms:${wsId}`);
    },
    remove: async (id: string) => {
      await api.removeRoom(wsId, id);
      invalidate(`rooms:${wsId}`);
    },
  };
}

/** A stored line as the room view draws it: yours, a teammate's, an agent's, Grok Bot's, or a job of the room's. */
export function toLine(l: RoomLineData, me: string | null): Line {
  const body = { text: l.text ?? "", steps: l.steps, error: l.error, by: l.by, via: l.via, files: l.files, proposals: l.proposals };
  switch (l.authorKind) {
    case "member":
      return l.authorId === me ? { id: l.id, who: "you", ...body } : { id: l.id, who: "person", author: l.authorId ?? undefined, ...body };
    case "agent":
      return { id: l.id, who: "agent", author: l.authorId ?? undefined, ...body };
    case "grokbot":
      return { id: l.id, who: "agent", author: GROK_BOT.id, ...body };
    default:
      return { id: l.id, who: "agent", author: l.authorId ?? undefined, text: "", job: l.taskId ?? undefined };
  }
}

/** The lines of one room on the server, with what you just said shown at once (until the server has it). */
function useRoomStore(room: Room, agents: Agent[]): RoomStore {
  const { wsId, ws } = useCosign();
  const me = ws.me.memberId;
  const { tasks } = useAgentsData();
  const key = `room-lines:${wsId}:${room.id}`;
  const data = useData(key, () => api.roomLines(wsId, room.id));
  const [pending, setPending] = useState<{ n: number; line: Line }[]>([]);
  useEffect(() => {
    // new lines from others, and the steps of a job running in the room
    const id = setInterval(() => invalidate(key, `tasks:${wsId}`), LINES_POLL_MS);
    return () => clearInterval(id);
  }, [key, wsId]);

  const stored = useMemo(() => (data.data?.lines ?? []).map((l) => toLine(l, me)), [data.data, me]);
  const lines = useMemo(() => [...stored, ...pending.map((p) => p.line)], [stored, pending]);

  const say = useCallback(
    (l: Line) => {
      const n = Date.now() + Math.random();
      setPending((cur) => [...cur, { n, line: l }]);
      const kind = l.who === "you" ? "member" : l.author === GROK_BOT.id ? "grokbot" : "agent";
      const body = { text: l.text || undefined, steps: l.steps, error: l.error, by: l.by, via: l.via, files: l.files, proposals: l.proposals };
      void api
        .postRoomLine(wsId, room.id, { kind, authorId: kind === "agent" ? (l.author ?? null) : null, body })
        .catch(() => {})
        .then(() => api.roomLines(wsId, room.id))
        .then(() => {
          invalidate(key);
          setPending((cur) => cur.filter((p) => p.n !== n));
        });
    },
    [wsId, room.id, key],
  );

  const addMembers = useCallback(
    (ids: string[]) => {
      void api.addRoomMembers(wsId, room.id, ids.map((x) => (x === ME ? me : x)).filter((x): x is string => !!x)).then(() => invalidate(`rooms:${wsId}`));
    },
    [wsId, room.id, me],
  );

  const render = useCallback(
    (l: Line) => {
      if (!l.job) return null;
      const task = tasks.find((t) => t.id === l.job);
      const agent = agents.find((a) => a.id === task?.agentId);
      // not loaded yet, or an agent you can't see: draw nothing rather than an empty turn
      return task && agent ? <JobView task={task} agent={agent} /> : <></>;
    },
    [tasks, agents],
  );

  // the approval card of each payment an agent drafted here: Approve for an approver, waiting for anyone else, then Paid
  const below = useCallback(
    (l: Line) => {
      const agent = agents.find((a) => a.id === l.author);
      if (!agent || !l.proposals?.length) return null;
      return l.proposals.map((pid) => <ToolCard key={pid} agent={agent} call={{ name: "propose_payment", args: {}, result: { proposalId: pid }, t: "" }} />);
    },
    [agents],
  );

  return { lines, say, addMembers, render, below };
}

/** A room on the server: the room view, reading and writing the shared lines. */
export function ServerRoom(props: {
  room: Room;
  files: Picked[];
  setFiles: (update: (cur: Picked[]) => Picked[]) => void;
  ask: RoomAsk;
  people: { agents: Agent[]; team: Teammate[] };
}) {
  const store = useRoomStore(props.room, props.people.agents);
  return <RoomView room={props.room} files={props.files} setFiles={props.setFiles} ask={props.ask} people={props.people} store={store} />;
}
