/**
 * Local SQLite (Drizzle + better-sqlite3). One file: data/cosign.db (gitignored).
 * Tables are created on first use (no migration step needed for the hackathon).
 * Server-only.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema";

const DB_FILE = process.env.COSIGN_DB ?? "data/cosign.db";

const g = globalThis as unknown as { __cosignDb?: ReturnType<typeof open> };

function open() {
  mkdirSync(dirname(DB_FILE), { recursive: true });
  const sqlite = new Database(DB_FILE);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      block_time INTEGER,
      type TEXT NOT NULL,
      treasury TEXT,
      actor TEXT,
      counterparty TEXT,
      amount_usd TEXT,
      proposal_id TEXT,
      summary TEXT NOT NULL,
      raw TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'quicknode',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE (tx_hash, log_index)
    );
    CREATE INDEX IF NOT EXISTS activity_block ON activity (block_number DESC);
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nonce TEXT NOT NULL UNIQUE,
      received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      events INTEGER NOT NULL,
      inserted INTEGER NOT NULL
    );
  `);
  return drizzle(sqlite, { schema });
}

export function db() {
  return (g.__cosignDb ??= open());
}
export { schema };
