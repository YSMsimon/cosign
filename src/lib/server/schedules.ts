/**
 * Schedules live on our site (the dashboard shows and edits them). When one is due, our server
 * creates a task: Grok Bot gets it through its webhook routine, or our own loop runs it when no Bot
 * is connected. Runs use the rights of the member who made the schedule (checked again every run).
 * The tick is POST /api/v1/cron/tick (Vercel Cron in production, scripts/scheduler.ts locally).
 * Server-only.
 */
import { and, eq, lte } from "drizzle-orm";
import { db, schema } from "../db";
import type { AgentRow, ScheduleRow } from "../db/schema";
import { can, canUseAgent } from "../perm/permissions";
import { memberAccess, type Membership } from "./access";
import { accessOf } from "./agents";
import { startTask } from "./grokbot";
import { badRequest, forbidden, notFound } from "./http";
import { id, nextRun, validateSpec, type ScheduleSpec } from "./util";

const now = () => new Date().toISOString();

export const scheduleView = (s: ScheduleRow) => ({ ...s, enabled: !!s.enabled, spec: JSON.parse(s.spec) as ScheduleSpec });

export function createSchedule(m: Membership, agent: AgentRow, o: { name: string; instructions: string; spec: Partial<ScheduleSpec>; enabled?: boolean }) {
  if (!can(m.permissions, "schedules.create")) throw forbidden(`your role (${m.role.name}) can't create schedules`);
  if (!canUseAgent(accessOf(agent), memberAccess(m))) throw forbidden("you can only schedule agents you can use");
  let spec: ScheduleSpec;
  try {
    spec = validateSpec(o.spec);
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  const row: ScheduleRow = {
    id: id("sch"),
    workspaceId: agent.workspaceId,
    agentId: agent.id,
    name: o.name,
    instructions: o.instructions,
    spec: JSON.stringify(spec),
    nextRunAt: nextRun(spec, new Date()).toISOString(),
    lastRunAt: null,
    enabled: o.enabled === false ? 0 : 1,
    createdBy: m.member.id,
    createdAt: now(),
  };
  db().insert(schema.schedules).values(row).run();
  return scheduleView(row);
}

export const listSchedules = (agentId: string) => db().select().from(schema.schedules).where(eq(schema.schedules.agentId, agentId)).all().map(scheduleView);

function editable(m: Membership, scheduleId: string) {
  const s = db().select().from(schema.schedules).where(and(eq(schema.schedules.id, scheduleId), eq(schema.schedules.workspaceId, m.workspace.id))).get();
  if (!s) throw notFound("schedule not found");
  if (s.createdBy !== m.member.id && !can(m.permissions, "agents.manage")) throw forbidden("only its creator or All access can change a schedule");
  return s;
}

export function updateSchedule(m: Membership, scheduleId: string, o: { name?: string; instructions?: string; spec?: Partial<ScheduleSpec>; enabled?: boolean; nextRunAt?: string }) {
  const s = editable(m, scheduleId);
  const set: Partial<ScheduleRow> = {};
  if (o.name !== undefined) set.name = o.name;
  if (o.instructions !== undefined) set.instructions = o.instructions;
  if (o.enabled !== undefined) set.enabled = o.enabled ? 1 : 0;
  if (o.spec) {
    let spec: ScheduleSpec;
    try {
      spec = validateSpec(o.spec);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    set.spec = JSON.stringify(spec);
    set.nextRunAt = nextRun(spec, new Date()).toISOString();
  }
  if (o.nextRunAt !== undefined) {
    const t = Date.parse(o.nextRunAt);
    if (!Number.isFinite(t)) throw badRequest("nextRunAt must be an ISO date");
    set.nextRunAt = new Date(t).toISOString(); // "run now" = set it to the past
  }
  db().update(schema.schedules).set(set).where(eq(schema.schedules.id, s.id)).run();
  return scheduleView(db().select().from(schema.schedules).where(eq(schema.schedules.id, s.id)).get()!);
}

export function deleteSchedule(m: Membership, scheduleId: string) {
  const s = editable(m, scheduleId);
  db().delete(schema.schedules).where(eq(schema.schedules.id, s.id)).run();
  return { deleted: s.id };
}

/** Run every schedule that is due. Returns what happened and the work to continue after the response. */
export async function tick(base: string) {
  const due = db().select().from(schema.schedules).where(and(eq(schema.schedules.enabled, 1), lte(schema.schedules.nextRunAt, now()))).all();
  const results: { scheduleId: string; taskId?: string; engine?: string; status: string; error?: string }[] = [];
  const later: (() => Promise<void>)[] = [];
  for (const s of due) {
    const spec = JSON.parse(s.spec) as ScheduleSpec;
    // move the schedule forward first, so a slow or failing run never fires twice
    db().update(schema.schedules).set({ lastRunAt: now(), nextRunAt: nextRun(spec, new Date()).toISOString() }).where(eq(schema.schedules.id, s.id)).run();
    const agent = db().select().from(schema.agents).where(eq(schema.agents.id, s.agentId)).get();
    const ws = db().select().from(schema.workspaces).where(eq(schema.workspaces.id, s.workspaceId)).get();
    const member = db().select({ member: schema.members, perms: schema.roles.permissions }).from(schema.members).innerJoin(schema.roles, eq(schema.members.roleId, schema.roles.id)).where(eq(schema.members.id, s.createdBy)).get();
    if (!agent || !ws || agent.status !== "active") {
      results.push({ scheduleId: s.id, status: "skipped", error: "agent retired or missing" });
      continue;
    }
    const perms = member ? (JSON.parse(member.perms) as string[]) : [];
    if (!member || !can(perms, "schedules.create") || !canUseAgent(accessOf(agent), { id: member.member.id, roleId: member.member.roleId, permissions: perms })) {
      results.push({ scheduleId: s.id, status: "skipped", error: "its creator can no longer run this agent" });
      continue;
    }
    try {
      const { task, runLater } = await startTask(agent, ws, { kind: "task", source: "schedule", instructions: s.instructions, requestedBy: s.createdBy, scheduleId: s.id, base });
      if (runLater) later.push(runLater);
      results.push({ scheduleId: s.id, taskId: task.id, engine: task.engine, status: task.status, error: task.error ?? undefined });
    } catch (e) {
      results.push({ scheduleId: s.id, status: "failed", error: (e as Error).message });
    }
  }
  return { ran: results, later };
}
