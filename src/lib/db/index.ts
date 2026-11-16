/**
 * Local SQLite (Drizzle + better-sqlite3). One file: ~/.cosign/cosign.db (COSIGN_DB overrides it).
 *
 * It lives OUTSIDE the project folder on purpose. The dev server's file watcher (Turbopack, inside the same
 * process) reads files in the project that change, and the database changes on every write. On macOS, when any
 * code in a process opens and closes a file, the OS drops every lock that process holds on it, SQLite's included.
 * The server then holds the database without its locks, and the next script that opens and closes it (pnpm grokbot,
 * pnpm voice, the evals) looks like the last user and deletes the write-ahead log under the server: a split.
 * Out of the watched folder, nothing else in the server touches the file, and scripts are safe to run.
 * Tables are created on first use (no migration step needed for the hackathon).
 * Server-only.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync, statSync } from "node:fs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as schema from "./schema";

const DB_FILE = process.env.COSIGN_DB ?? join(homedir(), ".cosign", "cosign.db");
const OLD_DB_FILE = "data/cosign.db"; // where it used to live, inside the project

const g = globalThis as unknown as { __cosignDb?: ReturnType<typeof open> };

function open() {
  if (!process.env.COSIGN_DB && !existsSync(DB_FILE) && existsSync(OLD_DB_FILE)) {
    throw new Error(`[cosign] the database moved out of the project: stop the dev server, then move ${OLD_DB_FILE} (and any -wal / -shm next to it) to ${DB_FILE}`);
  }
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
  sqlite.exec(PRODUCT_DDL);
  migrate(sqlite);
  return drizzle(sqlite, { schema });
}

/** Columns added after a table first shipped (CREATE TABLE IF NOT EXISTS never changes an existing table). */
const MIGRATIONS = 2;
function migrate(sqlite: Database.Database) {
  const colsOf = (t: string) => (sqlite.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  if (!colsOf("agents").includes("hue")) sqlite.exec("ALTER TABLE agents ADD COLUMN hue TEXT");
  // 2: shared rooms (2026-11-16), and the room a draft, a job or a mention belongs to
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, visibility TEXT NOT NULL, guidelines TEXT NOT NULL DEFAULT '', members TEXT NOT NULL DEFAULT '[]', created_by TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS rooms_ws ON rooms (workspace_id);
    CREATE TABLE IF NOT EXISTS room_lines (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, workspace_id TEXT NOT NULL, author_kind TEXT NOT NULL, author_id TEXT, posted_by TEXT, body TEXT NOT NULL DEFAULT '{}', task_id TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS room_lines_room ON room_lines (room_id, created_at);
  `);
  for (const t of ["proposal_meta", "tasks", "team_messages"]) if (!colsOf(t).includes("room_id")) sqlite.exec(`ALTER TABLE ${t} ADD COLUMN room_id TEXT`);
  (globalThis as unknown as { __cosignMigrated?: number }).__cosignMigrated = MIGRATIONS;
}

/** Workspaces, people, agents, Grok Bot, schedules and the team feed (mirrors schema.ts). */
const PRODUCT_DDL = `
  CREATE TABLE IF NOT EXISTS users (address TEXT PRIMARY KEY, created_at TEXT NOT NULL, last_login_at TEXT);
  CREATE TABLE IF NOT EXISTS auth_nonces (nonce TEXT PRIMARY KEY, created_at TEXT NOT NULL, used_at TEXT);
  CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, address TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, treasury TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, key TEXT, name TEXT NOT NULL, permissions TEXT NOT NULL, system INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE (workspace_id, name));
  CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, address TEXT NOT NULL, role_id TEXT NOT NULL, title TEXT, invited_by TEXT, created_at TEXT NOT NULL, joined_at TEXT, UNIQUE (workspace_id, address));
  CREATE INDEX IF NOT EXISTS members_addr ON members (address);
  CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, address TEXT NOT NULL, notes TEXT, created_by TEXT, created_at TEXT NOT NULL, UNIQUE (workspace_id, address));
  CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL, visibility TEXT NOT NULL, allowed_role_ids TEXT, owner_member_id TEXT NOT NULL, abilities TEXT NOT NULL, controls TEXT NOT NULL, ref TEXT NOT NULL UNIQUE, wallet_id TEXT NOT NULL, wallet_address TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', hue TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS agents_ws ON agents (workspace_id);
  CREATE TABLE IF NOT EXISTS agent_spend (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, kind TEXT NOT NULL, amount_usd TEXT NOT NULL, ref TEXT, member_id TEXT, task_id TEXT, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS agent_spend_agent ON agent_spend (agent_id, created_at);
  CREATE TABLE IF NOT EXISTS approval_requests (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL, requested_by TEXT, kind TEXT NOT NULL, url TEXT NOT NULL, host TEXT NOT NULL, amount_usd TEXT NOT NULL, status TEXT NOT NULL, decided_by TEXT, decided_at TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS proposal_meta (treasury TEXT NOT NULL, proposal_id TEXT NOT NULL, agent_id TEXT, requested_by TEXT, task_id TEXT, created_at TEXT NOT NULL, UNIQUE (treasury, proposal_id));
  CREATE TABLE IF NOT EXISTS grokbot_connections (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL UNIQUE, webhook_url TEXT NOT NULL, webhook_key_enc TEXT NOT NULL, status TEXT NOT NULL, last_error TEXT, connected_at TEXT, created_by TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, engine TEXT NOT NULL, instructions TEXT NOT NULL, status TEXT NOT NULL, token_hash TEXT, token_expires_at TEXT, requested_by TEXT, schedule_id TEXT, progress TEXT NOT NULL DEFAULT '[]', result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS tasks_token ON tasks (token_hash);
  CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, spec TEXT NOT NULL, next_run_at TEXT NOT NULL, last_run_at TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS team_messages (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, from_kind TEXT NOT NULL, from_id TEXT, to_kind TEXT, to_id TEXT, text TEXT NOT NULL, task_id TEXT, from_task_id TEXT, root_id TEXT NOT NULL, depth INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS team_messages_ws ON team_messages (workspace_id, created_at);
  CREATE INDEX IF NOT EXISTS team_messages_task ON team_messages (task_id);
  CREATE TABLE IF NOT EXISTS funding_requests (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL, requested_by TEXT, asked_member_id TEXT NOT NULL, amount_usd TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL, session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS mcp_tokens (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL, member_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, last_used_at TEXT);
`;

/** Raw better-sqlite3 handle, for the few places that want plain synchronous SQL. */
export function sqlite(): Database.Database {
  return (db() as unknown as { $client: Database.Database }).$client;
}

/**
 * Split guard. While this process has the database open, its write-ahead log (cosign.db-wal) must
 * stay the same file. Twice on 2026-11-13 it was deleted under the running dev server (another process
 * closed the database after the server's file locks had been dropped), so the server kept writing to a
 * log nobody else could see. If that happens, stop this process at once WITHOUT closing the database:
 * a normal close would copy the stale log back over newer data. Back up data/, then restart.
 */
const wal = globalThis as unknown as { __cosignWalIno?: number; __cosignWalChecked?: number };
function guardWal() {
  const t = Date.now();
  if (t - (wal.__cosignWalChecked ?? 0) < 1000) return;
  wal.__cosignWalChecked = t;
  let ino: number | null = null;
  try {
    ino = statSync(`${DB_FILE}-wal`).ino;
  } catch {}
  if (wal.__cosignWalIno === undefined) {
    if (ino !== null) wal.__cosignWalIno = ino;
    return;
  }
  if (ino !== wal.__cosignWalIno) {
    console.error(
      `[cosign] ${DB_FILE}-wal was deleted or replaced by another process while this process had it open (a database split). ` +
        "Stopping now without closing the database, so the stale log is never written back. Back up data/, then restart.",
    );
    process.kill(process.pid, "SIGKILL");
  }
}

export function db() {
  const d = (g.__cosignDb ??= open());
  // a server that opened the database before a migration shipped runs it once on its open connection
  if ((globalThis as unknown as { __cosignMigrated?: number }).__cosignMigrated !== MIGRATIONS) migrate((d as unknown as { $client: Database.Database }).$client);
  guardWal();
  return d;
}
export { schema };
