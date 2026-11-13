import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Decoded onchain activity (treasury events + USDC transfers touching our wallets). */
export const activity = sqliteTable(
  "activity",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: integer("block_number").notNull(),
    blockTime: integer("block_time"),
    type: text("type").notNull(), // proposal_created | proposal_approved | payment_executed | agent_topped_up | usdc_transfer | ...
    treasury: text("treasury"),
    actor: text("actor"),
    counterparty: text("counterparty"),
    amountUsd: text("amount_usd"),
    proposalId: text("proposal_id"),
    summary: text("summary").notNull(),
    raw: text("raw").notNull(),
    source: text("source").notNull().default("quicknode"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("activity_tx_log").on(t.txHash, t.logIndex)],
);

/** One row per verified webhook delivery (nonce = replay guard). */
export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  nonce: text("nonce").notNull().unique(),
  receivedAt: text("received_at").notNull(),
  events: integer("events").notNull(),
  inserted: integer("inserted").notNull(),
});

export type ActivityRow = typeof activity.$inferSelect;
export type NewActivity = typeof activity.$inferInsert;

