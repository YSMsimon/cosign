/**
 * Rooms: shared conversations for people and agents (Simon, 2026-11-16: "that's why we designed group"). Everyone in a
 * room sees the same messages. A person's message is posted by them; an agent's answer is posted by the person who
 * asked it (their browser ran the turn); a background job that belongs to the room (Grok Bot checking a payment that
 * was drafted there) is posted by the server, and the app shows the job itself as it runs. Server-only.
 */
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { db, schema } from "../db";
import type { RoomLineRow, RoomRow, TaskRow } from "../db/schema";
import { can } from "../perm/permissions";
import type { Membership } from "./access";
import { badRequest, forbidden, notFound } from "./http";
import { id } from "./util";

/** What a room line says. Steps are an answer's steps ("Read the bill · paid $0.01"), as the room shows them. */
export type LineBody = {
  text?: string;
  steps?: { title: string; lines: string[] };
  error?: string;
  /** a Grok Bot job that ran on this agent's own loop: shown as the agent's turn, tagged Background */
  by?: string;
  via?: "voice";
  files?: string[];
  /** treasury proposals the answer drafted: the room shows each one's approval card */
  proposals?: string[];
};

const MAX_TEXT = 20_000;
const now = () => new Date().toISOString();
const membersOf = (r: RoomRow) => JSON.parse(r.members) as string[];

export const roomView = (r: RoomRow) => ({
  id: r.id,
  name: r.name,
  visibility: r.visibility as "public" | "private",
  guidelines: r.guidelines,
  members: membersOf(r),
  createdBy: r.createdBy,
  createdAt: r.createdAt,
});

export const lineView = (l: RoomLineRow) => ({
  id: l.id,
  authorKind: l.authorKind as "member" | "agent" | "grokbot" | "job",
  authorId: l.authorId,
  postedBy: l.postedBy,
  taskId: l.taskId,
  createdAt: l.createdAt,
  ...(JSON.parse(l.body) as LineBody),
});

const canSee = (m: Membership, r: RoomRow) => r.workspaceId === m.workspace.id && (r.visibility === "public" || membersOf(r).includes(m.member.id));

function roomFor(m: Membership, roomId: string): RoomRow {
  const r = db().select().from(schema.rooms).where(eq(schema.rooms.id, roomId)).get();
  if (!r || !canSee(m, r)) throw notFound("room not found");
  return r;
}

/** The ids that can be in a room: this workspace's people and its active agents. */
function inWorkspace(workspaceId: string, ids: string[]): string[] {
  if (!ids.length) return [];
  const people = db().select({ id: schema.members.id }).from(schema.members).where(and(eq(schema.members.workspaceId, workspaceId), inArray(schema.members.id, ids))).all();
  const agents = db()
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.status, "active"), inArray(schema.agents.id, ids)))
    .all();
  const ok = new Set([...people, ...agents].map((x) => x.id));
  return [...new Set(ids)].filter((x) => ok.has(x));
}

/** The rooms you can see: every public room in the workspace, and the private ones you are in. */
export function listRooms(m: Membership) {
  return db()
    .select()
    .from(schema.rooms)
    .where(eq(schema.rooms.workspaceId, m.workspace.id))
    .orderBy(asc(schema.rooms.createdAt))
    .all()
    .filter((r) => canSee(m, r))
    .map(roomView);
}

export function createRoom(m: Membership, o: { name: string; visibility: "public" | "private"; guidelines?: string; members?: string[] }) {
  const name = o.name.trim().replace(/^#/, "");
  if (!name) throw badRequest("a room needs a name");
  const row: RoomRow = {
    id: id("room"),
    workspaceId: m.workspace.id,
    name,
    visibility: o.visibility,
    guidelines: (o.guidelines ?? "").trim(),
    members: JSON.stringify([m.member.id, ...inWorkspace(m.workspace.id, (o.members ?? []).filter((x) => x !== m.member.id))]),
    createdBy: m.member.id,
    createdAt: now(),
  };
  db().insert(schema.rooms).values(row).run();
  return roomView(row);
}

/** Add people or agents. Anyone can join a public room (themselves); inviting others takes being in the room. */
export function addRoomMembers(m: Membership, roomId: string, ids: string[]) {
  const r = roomFor(m, roomId);
  const cur = membersOf(r);
  const joiningSelf = ids.length === 1 && ids[0] === m.member.id;
  if (!cur.includes(m.member.id) && !(joiningSelf && r.visibility === "public")) throw forbidden("join the room before inviting others");
  const next = [...new Set([...cur, ...inWorkspace(m.workspace.id, ids)])];
  db().update(schema.rooms).set({ members: JSON.stringify(next) }).where(eq(schema.rooms.id, r.id)).run();
  return roomView({ ...r, members: JSON.stringify(next) });
}

/** Delete a room and what was said in it: whoever made it, or someone who manages members. */
export function removeRoom(m: Membership, roomId: string) {
  const r = roomFor(m, roomId);
  if (r.createdBy !== m.member.id && !can(m.permissions, "members.manage")) throw forbidden("only the person who made the room can delete it");
  db().delete(schema.roomLines).where(eq(schema.roomLines.roomId, r.id)).run();
  db().delete(schema.rooms).where(eq(schema.rooms.id, r.id)).run();
  return { ok: true };
}

/** A room's messages, oldest first (after a time, to look for new ones). */
export function listRoomLines(m: Membership, roomId: string, after?: string | null) {
  const r = roomFor(m, roomId);
  const where = after ? and(eq(schema.roomLines.roomId, r.id), gt(schema.roomLines.createdAt, after)) : eq(schema.roomLines.roomId, r.id);
  return db().select().from(schema.roomLines).where(where).orderBy(asc(schema.roomLines.createdAt)).limit(1000).all().map(lineView);
}

function cleanBody(b: LineBody): LineBody {
  const out: LineBody = {};
  if (b.text) out.text = b.text.slice(0, MAX_TEXT);
  if (b.steps) out.steps = { title: b.steps.title.slice(0, 200), lines: b.steps.lines.slice(0, 100).map((s) => s.slice(0, 500)) };
  if (b.error) out.error = b.error.slice(0, 2000);
  if (b.by) out.by = b.by.slice(0, 80);
  if (b.via === "voice") out.via = "voice";
  if (b.files?.length) out.files = b.files.slice(0, 20).map((f) => f.slice(0, 200));
  if (b.proposals?.length) out.proposals = b.proposals.filter((x) => /^\d{1,9}$/.test(x)).slice(0, 10);
  return out;
}

/** What you said in a room, or the answer of an agent you asked there (your browser ran its turn). */
export function postRoomLine(m: Membership, roomId: string, o: { kind: "member" | "agent" | "grokbot"; authorId?: string | null; body: LineBody }) {
  const r = roomFor(m, roomId);
  const members = membersOf(r);
  if (!members.includes(m.member.id)) throw forbidden("join the room first");
  let authorId: string | null = m.member.id;
  if (o.kind === "agent") {
    if (!o.authorId || !members.includes(o.authorId)) throw badRequest("that agent isn't in this room");
    authorId = o.authorId;
  } else if (o.kind === "grokbot") {
    authorId = null;
  }
  const row: RoomLineRow = {
    id: id("rl"),
    roomId: r.id,
    workspaceId: r.workspaceId,
    authorKind: o.kind,
    authorId,
    postedBy: m.member.id,
    body: JSON.stringify(cleanBody(o.body)),
    taskId: null,
    createdAt: now(),
  };
  db().insert(schema.roomLines).values(row).run();
  return lineView(row);
}

/** Server side (no person posting): a line for a room that exists, else nothing. */
export function appendRoomLine(roomId: string, o: { authorKind: "agent" | "job"; authorId: string | null; body?: LineBody; taskId?: string | null }) {
  const r = db().select().from(schema.rooms).where(eq(schema.rooms.id, roomId)).get();
  if (!r) return null;
  const row: RoomLineRow = {
    id: id("rl"),
    roomId: r.id,
    workspaceId: r.workspaceId,
    authorKind: o.authorKind,
    authorId: o.authorId,
    postedBy: null,
    body: JSON.stringify(cleanBody(o.body ?? {})),
    taskId: o.taskId ?? null,
    createdAt: now(),
  };
  db().insert(schema.roomLines).values(row).run();
  return lineView(row);
}

/** A background job that belongs to a room shows there once, as the job itself (its steps and result as it runs). */
export function addJobLine(task: TaskRow) {
  if (!task.roomId) return null;
  const has = db().select({ id: schema.roomLines.id }).from(schema.roomLines).where(and(eq(schema.roomLines.roomId, task.roomId), eq(schema.roomLines.taskId, task.id))).get();
  if (has) return null;
  return appendRoomLine(task.roomId, { authorKind: "job", authorId: task.agentId, taskId: task.id });
}

/** A room id from a chat turn, kept only when it's a room in this workspace that you are in (else the turn has no room). */
export function memberRoom(m: Membership, roomId: string | undefined): string | null {
  if (!roomId) return null;
  const r = db().select().from(schema.rooms).where(eq(schema.rooms.id, roomId)).get();
  return r && r.workspaceId === m.workspace.id && membersOf(r).includes(m.member.id) ? r.id : null;
}

/** The room a treasury proposal was drafted from, if it was drafted in one. */
export function roomOfProposal(treasury: string, proposalId: string): string | null {
  const row = db()
    .select({ roomId: schema.proposalMeta.roomId })
    .from(schema.proposalMeta)
    .where(and(eq(schema.proposalMeta.treasury, treasury.toLowerCase()), eq(schema.proposalMeta.proposalId, proposalId)))
    .get();
  return row?.roomId ?? null;
}

/** The room a job belongs to (for a mention it makes). */
export function roomOfTask(taskId: string | null | undefined): string | null {
  if (!taskId) return null;
  return db().select({ roomId: schema.tasks.roomId }).from(schema.tasks).where(eq(schema.tasks.id, taskId)).get()?.roomId ?? null;
}
