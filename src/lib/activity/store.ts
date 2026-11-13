/**
 * Activity store: insert decoded events (deduped on tx_hash + log_index), list them, and notify
 * live subscribers (the dashboard's SSE feed). Server-only.
 */
import { desc } from "drizzle-orm";
import { EventEmitter } from "node:events";
import { db, schema } from "../db";
import type { ActivityRow, NewActivity } from "../db/schema";

const g = globalThis as unknown as { __cosignActivityBus?: EventEmitter };
export const activityBus = (g.__cosignActivityBus ??= new EventEmitter().setMaxListeners(100));

export function insertActivities(rows: NewActivity[]): ActivityRow[] {
  const inserted: ActivityRow[] = [];
  for (const r of rows) {
    const res = db().insert(schema.activity).values(r).onConflictDoNothing().returning().all();
    if (res[0]) inserted.push(res[0]);
  }
  for (const r of inserted) activityBus.emit("activity", r);
  return inserted;
}

export function listActivity(limit = 50): ActivityRow[] {
  return db()
    .select()
    .from(schema.activity)
    .orderBy(desc(schema.activity.blockNumber), desc(schema.activity.logIndex))
    .limit(Math.min(Math.max(limit, 1), 500))
    .all();
}

/** Record a verified delivery; returns false if this nonce was already processed (retry). */
export function recordDelivery(nonce: string, events: number, inserted: number): boolean {
  const res = db().insert(schema.webhookDeliveries).values({ nonce, events, inserted, receivedAt: new Date().toISOString() }).onConflictDoNothing().returning().all();
  return res.length > 0;
}
