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


// ───────────── people and workspaces ─────────────

/** Anyone who has signed in with a wallet (address = lowercase). */
export const users = sqliteTable("users", {
  address: text("address").primaryKey(),
  createdAt: text("created_at").notNull(),
  lastLoginAt: text("last_login_at"),
});

/** One-time SIWE nonces (10-minute life). */
export const authNonces = sqliteTable("auth_nonces", {
  nonce: text("nonce").primaryKey(),
  createdAt: text("created_at").notNull(),
  usedAt: text("used_at"),
});

/** Signed-in sessions; the cookie holds a random token, we store only its hash. */
export const authSessions = sqliteTable("auth_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  address: text("address").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

/** A company: one workspace per treasury contract. */
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  treasury: text("treasury").notNull().unique(), // lowercase
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
});

export const roles = sqliteTable(
  "roles",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    key: text("key"), // all_access | approver | null (member-level)
    name: text("name").notNull(),
    permissions: text("permissions").notNull(), // JSON string[]
    system: integer("system").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("roles_ws_name").on(t.workspaceId, t.name)],
);

/** A wallet address invited to a workspace. Access starts the first time that wallet signs in. */
export const members = sqliteTable(
  "members",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    address: text("address").notNull(), // lowercase
    roleId: text("role_id").notNull(),
    title: text("title"),
    invitedBy: text("invited_by"),
    createdAt: text("created_at").notNull(),
    joinedAt: text("joined_at"),
  },
  (t) => [uniqueIndex("members_ws_addr").on(t.workspaceId, t.address)],
);

/** Saved payees (the address book). Agents may only draft to the ones their controls allow. */
export const contacts = sqliteTable(
  "contacts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    address: text("address").notNull(), // lowercase
    notes: text("notes"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("contacts_ws_addr").on(t.workspaceId, t.address)],
);

// ───────────── agents ─────────────

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull(),
  prompt: text("prompt").notNull(), // its job description (static, cached)
  visibility: text("visibility").notNull(), // private | team
  allowedRoleIds: text("allowed_role_ids"), // JSON string[] | null (team agents)
  ownerMemberId: text("owner_member_id").notNull(),
  abilities: text("abilities").notNull(), // JSON Abilities
  controls: text("controls").notNull(), // JSON Controls
  ref: text("ref").notNull().unique(), // microVM / sandbox / Circle wallet refId
  walletId: text("wallet_id").notNull(),
  walletAddress: text("wallet_address").notNull(), // lowercase
  status: text("status").notNull().default("active"), // active | retired
  hue: text("hue"), // its orb colour, picked when it was made (violet | pink | orange | blue | teal)
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Money an agent moved or drafted, for budgets and the speed limit. */
export const agentSpend = sqliteTable("agent_spend", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  agentId: text("agent_id").notNull(),
  kind: text("kind").notNull(), // purchase | draft | topup
  amountUsd: text("amount_usd").notNull(),
  ref: text("ref"), // URL, proposal id or tx hash
  memberId: text("member_id"),
  taskId: text("task_id"),
  createdAt: text("created_at").notNull(),
});

/** "Ask a person above $X": a purchase waiting for a member's OK. */
export const approvalRequests = sqliteTable("approval_requests", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agentId: text("agent_id").notNull(),
  requestedBy: text("requested_by"), // member id (or null for schedules without a member)
  kind: text("kind").notNull(), // purchase
  url: text("url").notNull(),
  host: text("host").notNull(),
  amountUsd: text("amount_usd").notNull(),
  status: text("status").notNull(), // pending | approved | denied | used
  decidedBy: text("decided_by"),
  decidedAt: text("decided_at"),
  createdAt: text("created_at").notNull(),
});

/** Who asked for an onchain draft, and through which agent / task. */
export const proposalMeta = sqliteTable(
  "proposal_meta",
  {
    treasury: text("treasury").notNull(),
    proposalId: text("proposal_id").notNull(),
    agentId: text("agent_id"),
    requestedBy: text("requested_by"),
    taskId: text("task_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("proposal_meta_pk").on(t.treasury, t.proposalId)],
);

// ───────────── Grok Bot and schedules ─────────────

export const grokbotConnections = sqliteTable("grokbot_connections", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().unique(),
  webhookUrl: text("webhook_url").notNull(),
  webhookKeyEnc: text("webhook_key_enc").notNull(), // AES-GCM with COSIGN_SECRET
  status: text("status").notNull(), // pending | connected | failed
  lastError: text("last_error"),
  connectedAt: text("connected_at"),
  createdBy: text("created_by"),
  createdAt: text("created_at").notNull(),
});

/** One unit of background work for Grok Bot (or our own loop when no Bot is connected). */
export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agentId: text("agent_id").notNull(),
  kind: text("kind").notNull(), // ping | task | voice
  source: text("source").notNull(), // connect | member | schedule
  engine: text("engine").notNull(), // grokbot | cosign | elevenlabs
  instructions: text("instructions").notNull(),
  status: text("status").notNull(), // queued | sent | acked | working | done | failed
  tokenHash: text("token_hash"),
  tokenExpiresAt: text("token_expires_at"),
  requestedBy: text("requested_by"), // member id
  scheduleId: text("schedule_id"),
  progress: text("progress").notNull().default("[]"), // JSON [{t, message}]
  result: text("result"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agentId: text("agent_id").notNull(),
  name: text("name").notNull(),
  instructions: text("instructions").notNull(),
  spec: text("spec").notNull(), // JSON ScheduleSpec (UTC)
  nextRunAt: text("next_run_at").notNull(),
  lastRunAt: text("last_run_at"),
  enabled: integer("enabled").notNull().default(1),
  createdBy: text("created_by").notNull(), // member id; runs use this member's rights
  createdAt: text("created_at").notNull(),
});

// ───────────── team: agents and people handing work to each other ─────────────

/**
 * The team feed: every @mention made with the `mention` tool (agent → agent or agent → person) and every reply a
 * mentioned agent posts back. A mention of an agent starts a task for it (task_id). root_id / depth follow one chain
 * of hand-offs so the guards can stop agents looping without a person.
 */
export const teamMessages = sqliteTable("team_messages", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  fromKind: text("from_kind").notNull(), // agent | member | cosign
  fromId: text("from_id"),
  toKind: text("to_kind"), // agent | member | null (a reply to the team)
  toId: text("to_id"),
  text: text("text").notNull(),
  taskId: text("task_id"), // the task this mention started for the agent it names
  fromTaskId: text("from_task_id"), // the run that made this message
  rootId: text("root_id").notNull(),
  depth: integer("depth").notNull().default(0), // agent-to-agent hand-offs in a row in this chain
  createdAt: text("created_at").notNull(),
});

/** An agent asked for money: a person buys USDC into the treasury through Circle's onramp (server/funding.ts). */
export const fundingRequests = sqliteTable("funding_requests", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agentId: text("agent_id").notNull(),
  requestedBy: text("requested_by"), // the member the agent works for
  askedMemberId: text("asked_member_id").notNull(),
  amountUsd: text("amount_usd").notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull(), // pending | opened
  sessionId: text("session_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Connector tokens for Cosign's MCP endpoint (Grok Bot "Add a custom MCP": URL + Authorization header). One agent each; we keep only the hash. */
export const mcpTokens = sqliteTable("mcp_tokens", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agentId: text("agent_id").notNull(),
  memberId: text("member_id").notNull(), // who issued it; calls outside a job act for this member
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  lastUsedAt: text("last_used_at"),
});

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type RoleRow = typeof roles.$inferSelect;
export type MemberRow = typeof members.$inferSelect;
export type ContactRow = typeof contacts.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type ApprovalRow = typeof approvalRequests.$inferSelect;
export type ConnectionRow = typeof grokbotConnections.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type ScheduleRow = typeof schedules.$inferSelect;
export type TeamMessageRow = typeof teamMessages.$inferSelect;
export type McpTokenRow = typeof mcpTokens.$inferSelect;
export type FundingRequestRow = typeof fundingRequests.$inferSelect;
