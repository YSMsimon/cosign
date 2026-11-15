/**
 * The team feed's storage: write a message and announce it on the live bus. Shared by team.ts (mentions) and
 * grokbot.ts (a mentioned agent's reply when its task ends), so neither imports the other. Server-only.
 */
import { desc, eq } from "drizzle-orm";
import { activityBus } from "../activity/store";
import { db, schema } from "../db";
import type { TaskRow, TeamMessageRow } from "../db/schema";
import { id } from "./util";

export type TeamMessageInput = Omit<TeamMessageRow, "id" | "createdAt">;

/** Live event for the workspace stream: `team.message`. */
export type TeamMessageEvent = { workspaceId: string; message: TeamMessageRow };

export function postTeamMessage(m: TeamMessageInput): TeamMessageRow {
  const row: TeamMessageRow = { ...m, id: id("tm"), createdAt: new Date().toISOString() };
  db().insert(schema.teamMessages).values(row).run();
  activityBus.emit("team.message", { workspaceId: row.workspaceId, message: row } satisfies TeamMessageEvent);
  return row;
}

/** The mention that started this task, if a teammate's mention started it. */
export const mentionForTask = (taskId: string) => db().select().from(schema.teamMessages).where(eq(schema.teamMessages.taskId, taskId)).get();

/**
 * A mentioned agent finished (or failed) its task: post what it says back to the team, in the same chain, so the
 * agent that asked (and the people watching) see the answer. Tasks that no mention started post nothing.
 */
export function recordAgentReply(task: TaskRow, text: string, failed = false) {
  if (task.source !== "agent") return null;
  const asked = mentionForTask(task.id);
  if (!asked) return null;
  const body = (text ?? "").trim() || (failed ? "stopped without saying why" : "done");
  return postTeamMessage({
    workspaceId: task.workspaceId,
    fromKind: "agent",
    fromId: task.agentId,
    toKind: null,
    toId: null,
    text: failed ? `Couldn't finish: ${body}` : body,
    taskId: null,
    fromTaskId: task.id,
    rootId: asked.rootId,
    depth: asked.depth,
  });
}

export function listTeamMessages(workspaceId: string, limit = 100) {
  return db()
    .select()
    .from(schema.teamMessages)
    .where(eq(schema.teamMessages.workspaceId, workspaceId))
    .orderBy(desc(schema.teamMessages.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500))
    .all();
}
