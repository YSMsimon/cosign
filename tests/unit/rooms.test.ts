import "./_env";
import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { db, schema } from "../../src/lib/db";
import type { TaskRow } from "../../src/lib/db/schema";
import { loadMembership } from "../../src/lib/server/access";
import {
  addJobLine,
  addRoomMembers,
  createRoom,
  listRoomLines,
  listRooms,
  memberRoom,
  postRoomLine,
  removeRoom,
  roomOfProposal,
  roomOfTask,
} from "../../src/lib/server/rooms";
import { postTeamMessage } from "../../src/lib/server/team-feed";

// A workspace with Simon (All access), Emma (agent user) and Sam (agent user); agents Payables and Controller.
const now = new Date().toISOString();
const WS = "ws_rooms";
const addr = (n: number) => `0x${String(n).padStart(40, "0")}`;
db().insert(schema.workspaces).values({ id: WS, name: "Simon's Org", treasury: "0x00000000000000000000000000000000000000bb", createdBy: addr(1), createdAt: now }).run();
db().insert(schema.roles).values([
  { id: "rr_all", workspaceId: WS, key: "all_access", name: "All access", permissions: JSON.stringify(["agents.use_team", "members.manage"]), system: 1, createdAt: now },
  { id: "rr_user", workspaceId: WS, key: null, name: "Agent user", permissions: JSON.stringify(["agents.use_team"]), system: 0, createdAt: now },
]).run();
const member = (id: string, roleId: string, title: string, n: number) => ({ id, workspaceId: WS, address: addr(n), roleId, title, invitedBy: null, createdAt: now, joinedAt: now });
db().insert(schema.members).values([member("rm_simon", "rr_all", "Simon", 1), member("rm_emma", "rr_user", "Emma", 2), member("rm_sam", "rr_user", "Sam", 3)]).run();
const agent = (id: string, name: string) => ({
  id, workspaceId: WS, name, prompt: `${name} does its job`, visibility: "team", allowedRoleIds: null, ownerMemberId: "rm_simon", abilities: "{}", controls: "{}",
  ref: `ref_${id}`, walletId: `w_${id}`, walletAddress: `0x${id.padEnd(40, "0").slice(0, 40)}`, status: "active", createdAt: now, updatedAt: now,
});
db().insert(schema.agents).values([agent("ra_payables", "Payables"), agent("ra_controller", "Controller")] as never).run();

const simon = loadMembership(addr(1), WS)!;
const emma = loadMembership(addr(2), WS)!;
const sam = loadMembership(addr(3), WS)!;

test("a public room: everyone sees it and its messages; strangers' ids are dropped", () => {
  const room = createRoom(simon, { name: "#payments", visibility: "public", guidelines: "Bills and payments.", members: ["rm_emma", "ra_payables", "nobody", "rm_simon"] });
  assert.equal(room.name, "payments");
  assert.deepEqual(room.members, ["rm_simon", "rm_emma", "ra_payables"]);
  assert.ok(listRooms(sam).some((r) => r.id === room.id), "a public room is listed for everyone in the workspace");

  postRoomLine(simon, room.id, { kind: "member", body: { text: "@Payables pay Northpine." } });
  postRoomLine(simon, room.id, { kind: "agent", authorId: "ra_payables", body: { text: "Drafted it.", steps: { title: "Worked for 9 s", lines: ["Paid $0.01 by nanopayment · bill reader"] } } });
  postRoomLine(emma, room.id, { kind: "member", body: { text: "@Payables read bill 124." } });
  const seen = listRoomLines(emma, room.id);
  assert.deepEqual(seen.map((l) => [l.authorKind, l.authorId, l.text]), [
    ["member", "rm_simon", "@Payables pay Northpine."],
    ["agent", "ra_payables", "Drafted it."],
    ["member", "rm_emma", "@Payables read bill 124."],
  ]);
  assert.deepEqual(seen[1].steps?.lines, ["Paid $0.01 by nanopayment · bill reader"]);
  assert.equal(seen[1].postedBy, "rm_simon", "an agent's answer is posted by the person who asked it");

  assert.throws(() => postRoomLine(sam, room.id, { kind: "member", body: { text: "hi" } }), /join the room first/);
  assert.throws(() => postRoomLine(simon, room.id, { kind: "agent", authorId: "ra_controller", body: { text: "x" } }), /isn't in this room/);
  assert.throws(() => addRoomMembers(sam, room.id, ["rm_sam", "ra_controller"]), /join the room before inviting/);
  addRoomMembers(sam, room.id, ["rm_sam"]);
  assert.ok(listRooms(sam).find((r) => r.id === room.id)!.members.includes("rm_sam"), "anyone can join a public room");
});

test("a private room is invisible to people who aren't in it", () => {
  const room = createRoom(simon, { name: "payroll", visibility: "private", members: ["ra_payables"] });
  assert.ok(!listRooms(emma).some((r) => r.id === room.id));
  assert.throws(() => listRoomLines(emma, room.id), /room not found/);
  assert.throws(() => addRoomMembers(emma, room.id, ["rm_emma"]), /room not found/);
  assert.equal(memberRoom(emma, room.id), null, "a chat turn can't claim a room you aren't in");
  assert.equal(memberRoom(simon, room.id), room.id);
  assert.equal(memberRoom(simon, "finance"), null, "a browser-only room id is no room");
});

test("deleting a room: its maker or someone who manages members", () => {
  const room = createRoom(emma, { name: "scratch", visibility: "public" });
  postRoomLine(emma, room.id, { kind: "member", body: { text: "note" } });
  assert.throws(() => removeRoom(sam, room.id), /only the person who made the room/);
  removeRoom(simon, room.id);
  assert.ok(!listRooms(emma).some((r) => r.id === room.id));
  assert.equal(db().select().from(schema.roomLines).where(eq(schema.roomLines.roomId, room.id)).all().length, 0, "its messages go with it");
});

test("a payment drafted in a room is checked in that room: its job, then the job's mention", () => {
  const room = createRoom(simon, { name: "vendors", visibility: "public", members: ["rm_emma", "ra_payables"] });
  db().insert(schema.proposalMeta).values({ treasury: "0x00000000000000000000000000000000000000bb", proposalId: "12", agentId: "ra_payables", requestedBy: "rm_simon", taskId: null, roomId: room.id, createdAt: now }).run();
  assert.equal(roomOfProposal("0x00000000000000000000000000000000000000BB", "12"), room.id);
  assert.equal(roomOfProposal("0x00000000000000000000000000000000000000bb", "13"), null);

  const task: TaskRow = {
    id: "task_room_watch", workspaceId: WS, agentId: "ra_payables", kind: "task", source: "watch", engine: "grokbot",
    instructions: "Onchain · paid proposal #12: $0.08 to Northpine Hosting Inc., seen by QuickNode\n\nCheck it.", status: "queued",
    tokenHash: null, tokenExpiresAt: null, requestedBy: null, scheduleId: null, progress: "[]", result: null, error: null, roomId: room.id, createdAt: now, updatedAt: now,
  };
  db().insert(schema.tasks).values(task).run();
  assert.ok(addJobLine(task), "the job shows in the room");
  assert.equal(addJobLine(task), null, "once");
  assert.equal(roomOfTask(task.id), room.id);

  const msg = postTeamMessage({ workspaceId: WS, fromKind: "agent", fromId: "ra_payables", toKind: "member", toId: "rm_simon", text: "Proposal #12 is $0.72 short.", taskId: null, fromTaskId: task.id, rootId: "root1", depth: 0 });
  assert.equal(msg.roomId, room.id, "the mention belongs to the room");
  const lines = listRoomLines(emma, room.id);
  assert.deepEqual(lines.map((l) => [l.authorKind, l.authorId, l.taskId, l.text ?? null]), [
    ["job", "ra_payables", task.id, null],
    ["agent", "ra_payables", null, "@Simon Proposal #12 is $0.72 short."],
  ]);

  // a mention from a run outside any room stays out of rooms
  const plain = postTeamMessage({ workspaceId: WS, fromKind: "agent", fromId: "ra_payables", toKind: "member", toId: "rm_simon", text: "Hello.", taskId: null, fromTaskId: null, rootId: "root2", depth: 0 });
  assert.equal(plain.roomId, null);
  assert.equal(listRoomLines(simon, room.id).length, 2);
});
