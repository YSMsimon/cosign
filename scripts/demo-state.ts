/**
 * Save the demo company's state once it's set up, and put it back before each retake.
 *
 *   pnpm tsx --env-file=.env.local scripts/demo-state.ts save <name>      e.g. save seeded
 *   pnpm tsx --env-file=.env.local scripts/demo-state.ts restore <name>
 *   pnpm tsx --env-file=.env.local scripts/demo-state.ts rooms <name>     after save: adds the browser's rooms (see below)
 *   pnpm tsx --env-file=.env.local scripts/demo-state.ts rooms <name> emma   the same for Emma's browser (her own rooms)
 *   pnpm tsx --env-file=.env.local scripts/demo-state.ts list
 *   then: sh node_modules/.cosign-tmp/walcheck.sh
 *
 * What a snapshot holds (in ~/.cosign/snapshots/<name>/, outside the repo):
 *   - every agent's conversations (its session files: each person's chat, each room's thread, Grok Bot's job threads)
 *     and its memory files;
 *   - the app's rows for the company: agents (their settings, e.g. Pixel Studio off), members, contacts, background
 *     jobs, team messages (mentions), approval and funding requests;
 *   - the treasury's proposal count, so restore knows which drafts are new;
 *   - the company's rooms and every message in them (rooms live on the server since 2026-11-16: both windows see the
 *     same room). Older snapshots kept the browser's rooms in browser.json; restore still pastes those back.
 *
 * What restore does: cancels drafts made since the save that are still open (as the agent that drafted them; a paid
 * payment stays paid, the chain can't be rewound), puts the files and rows back, retires agents made since the save
 * (e.g. the Treasury Analyst from the last take), rewinds the agents' spend counters (the daily draft total and the
 * speed limit would otherwise refuse after a few takes; the payments themselves stay onchain), and tops up Payables'
 * wallet and Gateway balance.
 * Run it with nobody mid-turn. Old files go to ~/.Trash, never deleted.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { and, eq, gt, inArray } from "drizzle-orm";
import { createWalletClient, erc20Abi, http, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, cancelProposal, chain, fmt, readProposal, RECEIPT_POLL_MS, USDC, usdcBalance } from "../src/lib/arc";
import { companyTreasuryAbi } from "../src/lib/contracts/abis";
import { db, schema } from "../src/lib/db";
import { sandboxPaths } from "../src/lib/sandbox";

const COMPANY = process.env.DEMO_COMPANY ?? "Simon's Org";
const ROOT = join(homedir(), ".cosign", "snapshots");
const TRASH = join(homedir(), ".Trash");
const PAYABLES = "Payables";
const WALLET_FLOOR = 0.8; // top Payables' wallet back up to this from the deployer
const GATEWAY_FLOOR = 0.3; // and its Gateway balance (what its nanopayments spend)

type Rows = {
  agents: (typeof schema.agents.$inferSelect)[];
  members: (typeof schema.members.$inferSelect)[];
  contacts: (typeof schema.contacts.$inferSelect)[];
  tasks: (typeof schema.tasks.$inferSelect)[];
  teamMessages: (typeof schema.teamMessages.$inferSelect)[];
  approvalRequests: (typeof schema.approvalRequests.$inferSelect)[];
  fundingRequests: (typeof schema.fundingRequests.$inferSelect)[];
  /** absent in snapshots saved before rooms moved to the server */
  rooms?: (typeof schema.rooms.$inferSelect)[];
  roomLines?: (typeof schema.roomLines.$inferSelect)[];
};
type Meta = { company: string; workspaceId: string; treasury: string; proposalCount: number; savedAt: string };

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
/** Before 2026-11-16 rooms lived in the browser and `save` copied a console line to collect them. */
const SAVE_BROWSER_ROOMS = false;
const toTrash = (p: string, label: string) => {
  if (existsSync(p)) renameSync(p, join(TRASH, `cosign-${label}-${stamp()}`));
};
/** What of an agent's folder a snapshot keeps: its conversations and its memory (the VM's mounts stay in place). */
const parts = (ref: string) => {
  const p = sandboxPaths(ref);
  return { sessions: join(p.base, "sessions"), session: join(p.base, "session.json"), memory: join(p.workspace, "memory") };
};

function company() {
  const ws = db().select().from(schema.workspaces).where(eq(schema.workspaces.name, COMPANY)).get();
  if (!ws) throw new Error(`no workspace "${COMPANY}"`);
  return ws;
}

function rowsOf(wsId: string): Rows {
  const w = <T extends { workspaceId: unknown }>(t: T) => eq((t as unknown as { workspaceId: typeof schema.tasks.workspaceId }).workspaceId, wsId);
  return {
    agents: db().select().from(schema.agents).where(w(schema.agents)).all(),
    members: db().select().from(schema.members).where(w(schema.members)).all(),
    contacts: db().select().from(schema.contacts).where(w(schema.contacts)).all(),
    tasks: db().select().from(schema.tasks).where(w(schema.tasks)).all(),
    teamMessages: db().select().from(schema.teamMessages).where(w(schema.teamMessages)).all(),
    approvalRequests: db().select().from(schema.approvalRequests).where(w(schema.approvalRequests)).all(),
    fundingRequests: db().select().from(schema.fundingRequests).where(w(schema.fundingRequests)).all(),
    rooms: db().select().from(schema.rooms).where(w(schema.rooms)).all(),
    roomLines: db().select().from(schema.roomLines).where(w(schema.roomLines)).all(),
  };
}

/** A DevTools console line that copies this company's rooms (the room list and each room's lines) to the clipboard. */
const roomsCopyLine = (wsId: string) =>
  `copy(JSON.stringify({ rooms: localStorage.getItem("cosign-mock-rooms"), lines: Object.fromEntries(Object.entries(JSON.parse(localStorage.getItem("cosign-mock-lines") || "{}")).filter(([k]) => k.startsWith(${JSON.stringify(wsId + ":")}))) }))`;

function rooms(name: string, who?: string) {
  const dir = join(ROOT, name);
  if (!existsSync(join(dir, "meta.json"))) throw new Error(`no snapshot "${name}"`);
  const raw = execFileSync("pbpaste", { encoding: "utf8" });
  const b = JSON.parse(raw) as { rooms?: unknown; lines?: unknown };
  if (typeof b.rooms !== "string" || !b.lines || typeof b.lines !== "object") throw new Error("the clipboard doesn't hold the rooms; paste the console line from save first");
  const file = who === "emma" ? "browser-emma.json" : "browser.json"; // rooms live in each browser: yours and Emma's are kept apart
  writeFileSync(join(dir, file), raw);
  console.log(`saved ${who === "emma" ? "Emma's" : "your"} rooms into "${name}": ${Object.keys(b.lines).length} room(s) with messages`);
}

async function save(name: string) {
  const ws = company();
  const dir = join(ROOT, name);
  const keptRooms = existsSync(join(dir, "browser.json")) ? readFileSync(join(dir, "browser.json"), "utf8") : null;
  const keptEmma = existsSync(join(dir, "browser-emma.json")) ? readFileSync(join(dir, "browser-emma.json"), "utf8") : null;
  if (existsSync(dir)) toTrash(dir, `snapshot-${name}`); // a re-save replaces the old one (kept in the Trash)
  mkdirSync(dir, { recursive: true });
  if (keptRooms) writeFileSync(join(dir, "browser.json"), keptRooms); // the rooms from the last save, until `rooms` replaces them
  if (keptEmma) writeFileSync(join(dir, "browser-emma.json"), keptEmma);
  const rows = rowsOf(ws.id);
  for (const a of rows.agents) {
    const src = parts(a.ref);
    const dst = join(dir, "agents", a.ref);
    mkdirSync(dst, { recursive: true });
    if (existsSync(src.sessions)) cpSync(src.sessions, join(dst, "sessions"), { recursive: true });
    if (existsSync(src.session)) cpSync(src.session, join(dst, "session.json"));
    if (existsSync(src.memory)) cpSync(src.memory, join(dst, "memory"), { recursive: true });
  }
  const count = Number(await chain.readContract({ address: ws.treasury as Address, abi: companyTreasuryAbi, functionName: "proposalCount" }));
  const meta: Meta = { company: COMPANY, workspaceId: ws.id, treasury: ws.treasury, proposalCount: count, savedAt: new Date().toISOString() };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  writeFileSync(join(dir, "rows.json"), JSON.stringify(rows, null, 2));
  console.log(`saved "${name}": ${rows.agents.length} agents, ${rows.tasks.length} jobs, ${rows.teamMessages.length} team messages, ${rows.rooms?.length ?? 0} rooms (${rows.roomLines?.length ?? 0} messages), ${count} proposals so far → ${dir}`);
  if (!SAVE_BROWSER_ROOMS) return; // rooms are on the server and in rows.json
  execFileSync("pbcopy", { input: roomsCopyLine(ws.id) });
  console.log(
    `${keptRooms ? "kept the rooms from the last save. To save the rooms as they are now: " : "rooms live in your browser: "}a console line is on your clipboard. Paste it into the browser console on localhost:3000, then run: demo-state.ts rooms ${name}`,
  );
}

async function restore(name: string) {
  const dir = join(ROOT, name);
  if (!existsSync(join(dir, "meta.json"))) throw new Error(`no snapshot "${name}" in ${ROOT}`);
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Meta;
  const saved = JSON.parse(readFileSync(join(dir, "rows.json"), "utf8")) as Rows;
  const ws = company();
  if (ws.id !== meta.workspaceId) throw new Error(`snapshot is for ${meta.workspaceId}, the company is ${ws.id}`);
  const t = ws.treasury as Address;
  const now = rowsOf(ws.id);
  const byWallet = new Map(now.agents.map((a) => [a.walletAddress.toLowerCase(), a]));

  // 1. drafts made since the save that are still open: cancelled by the agent that drafted them
  const count = Number(await chain.readContract({ address: t, abi: companyTreasuryAbi, functionName: "proposalCount" }));
  for (let pid = meta.proposalCount; pid < count; pid++) {
    const p = await readProposal(t, BigInt(pid));
    if (p.executed || p.cancelled) {
      console.log(`1. proposal #${pid}: ${p.executed ? "paid (stays paid)" : "already cancelled"}`);
      continue;
    }
    const by = byWallet.get(p.proposer.toLowerCase());
    if (!by) {
      console.log(`1. proposal #${pid} is open but wasn't drafted by one of our agents: cancel it in the app`);
      continue;
    }
    await cancelProposal(by.ref, t, BigInt(pid));
    console.log(`1. cancelled open draft #${pid} (${fmt(p.amount)} USDC, drafted by ${by.name})`);
  }

  // 2. the rows, as they were
  const savedIds = new Set(saved.agents.map((a) => a.id));
  db().transaction((tx) => {
    for (const a of now.agents.filter((x) => !savedIds.has(x.id))) {
      tx.update(schema.agents).set({ status: "retired", updatedAt: new Date().toISOString() }).where(eq(schema.agents.id, a.id)).run();
      console.log(`2. retired ${a.name} (made since the save)`);
    }
    for (const a of saved.agents) tx.update(schema.agents).set(a).where(eq(schema.agents.id, a.id)).run();
    const swap = <R extends { id: string }>(table: typeof schema.tasks | typeof schema.teamMessages | typeof schema.approvalRequests | typeof schema.fundingRequests | typeof schema.members | typeof schema.contacts | typeof schema.rooms | typeof schema.roomLines, rows: R[]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the same delete/insert for six tables with the same workspace column
      const tb = table as any;
      tx.delete(tb).where(eq(tb.workspaceId, ws.id)).run();
      if (rows.length) tx.insert(tb).values(rows).run();
    };
    swap(schema.members, saved.members);
    swap(schema.contacts, saved.contacts);
    swap(schema.tasks, saved.tasks);
    swap(schema.teamMessages, saved.teamMessages);
    swap(schema.approvalRequests, saved.approvalRequests);
    swap(schema.fundingRequests, saved.fundingRequests);
    if (saved.rooms) {
      // rooms made since the save go, and each saved room's messages are exactly as saved
      swap(schema.roomLines, saved.roomLines ?? []);
      swap(schema.rooms, saved.rooms);
    }
    // the limits' counters as they were at the save (a take's drafts and calls would otherwise count against the next)
    if (saved.agents.length) {
      tx.delete(schema.agentSpend)
        .where(and(inArray(schema.agentSpend.agentId, saved.agents.map((a) => a.id)), gt(schema.agentSpend.createdAt, meta.savedAt)))
        .run();
    }
  });
  console.log(`2. rows back: ${saved.tasks.length} jobs, ${saved.teamMessages.length} team messages, ${saved.rooms?.length ?? 0} rooms (${saved.roomLines?.length ?? 0} messages), ${saved.members.length} members, ${saved.contacts.length} contacts; agent settings as saved`);

  // 3. the conversations and memory files
  for (const a of saved.agents) {
    const src = join(dir, "agents", a.ref);
    const dst = parts(a.ref);
    toTrash(dst.sessions, `${a.ref}-sessions`);
    if (existsSync(join(src, "sessions"))) cpSync(join(src, "sessions"), dst.sessions, { recursive: true });
    toTrash(dst.session, `${a.ref}-session.json`);
    if (existsSync(join(src, "session.json"))) cpSync(join(src, "session.json"), dst.session);
    if (existsSync(dst.memory)) for (const f of readdirSync(dst.memory)) toTrash(join(dst.memory, f), `${a.ref}-memory-${f}`);
    mkdirSync(dst.memory, { recursive: true });
    if (existsSync(join(src, "memory"))) for (const f of readdirSync(join(src, "memory"))) cpSync(join(src, "memory", f), join(dst.memory, f), { recursive: true });
  }
  console.log(`3. conversations and memory back for ${saved.agents.map((a) => a.name).join(", ")}`);

  // 4. money for the next take: Payables' wallet and Gateway balance
  const payables = saved.agents.find((a) => a.name === PAYABLES);
  if (payables) {
    const addr = payables.walletAddress as Address;
    let bal = Number(fmt(await usdcBalance(addr)));
    if (bal < WALLET_FLOOR) {
      const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex);
      const client = createWalletClient({ account: deployer, chain: arcTestnet, transport: http() });
      const amount = (WALLET_FLOOR + 0.5 - bal).toFixed(2);
      const hash = await client.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [addr, parseUnits(amount, 6)] });
      await chain.waitForTransactionReceipt({ hash, pollingInterval: RECEIPT_POLL_MS });
      bal += Number(amount);
      console.log(`4. sent Payables $${amount} from the deployer`);
    }
    const { kitGatewayBalance, kitGatewayDeposit } = await import("../src/lib/appkit");
    const gw = Number((await kitGatewayBalance(addr).catch(() => null)) ?? 0);
    if (gw < GATEWAY_FLOOR) {
      const amount = (GATEWAY_FLOOR + 0.2 - gw).toFixed(2);
      await kitGatewayDeposit(addr, amount);
      console.log(`4. moved $${amount} into Payables' Gateway balance (was $${gw.toFixed(2)})`);
    } else console.log(`4. Payables: wallet $${bal.toFixed(2)}, Gateway $${gw.toFixed(2)}`);
  }

  // 5. older snapshots: the rooms each browser kept (yours on the clipboard; Emma's in a file to paste in her window)
  const emmaRooms = join(dir, "browser-emma.json");
  if (!saved.rooms && existsSync(emmaRooms)) {
    const e = JSON.parse(readFileSync(emmaRooms, "utf8")) as { rooms: string; lines: Record<string, unknown> };
    const line = `localStorage.setItem("cosign-mock-rooms", ${JSON.stringify(e.rooms)}); const l = JSON.parse(localStorage.getItem("cosign-mock-lines") || "{}"); for (const k of Object.keys(l)) if (k.startsWith(${JSON.stringify(meta.workspaceId + ":")})) delete l[k]; Object.assign(l, ${JSON.stringify(e.lines)}); localStorage.setItem("cosign-mock-lines", JSON.stringify(l)); location.reload();`;
    writeFileSync(join(ROOT, "emma-rooms.js"), line);
    console.log(`5. Emma's rooms: pbcopy < ${join(ROOT, "emma-rooms.js")}, then paste into the console in Emma's window`);
  }
  const browser = join(dir, "browser.json");
  if (saved.rooms) console.log(`5. rooms: ${saved.rooms.length} on the server, as saved (both windows see them)`);
  else if (existsSync(browser)) {
    const b = JSON.parse(readFileSync(browser, "utf8")) as { rooms: string; lines: Record<string, unknown> };
    // the room list as saved; each saved room's lines merged into the browser's (other companies' rooms untouched)
    const js = `localStorage.setItem("cosign-mock-rooms", ${JSON.stringify(b.rooms)}); const l = JSON.parse(localStorage.getItem("cosign-mock-lines") || "{}"); Object.assign(l, ${JSON.stringify(b.lines)}); localStorage.setItem("cosign-mock-lines", JSON.stringify(l)); location.reload();`;
    execFileSync("pbcopy", { input: js });
    console.log("5. rooms: a console line is on your clipboard; paste it into the browser console on localhost:3000");
  } else console.log("5. no browser.json in this snapshot: rooms stay as they are in the browser");
  // Oliver's weekly bills (122+): the next one no proposal has named yet, for Emma to ask about in this take
  const used = new Set<number>();
  const total = Number(await chain.readContract({ address: t, abi: companyTreasuryAbi, functionName: "proposalCount" }));
  for (let pid = 0; pid < total; pid++) {
    const m = /(?:bill|invoice)\s*#?(\d+)/i.exec((await readProposal(t, BigInt(pid))).memo);
    if (m) used.add(Number(m[1]));
  }
  let fresh = 122;
  while (used.has(fresh)) fresh++;
  console.log(`6. Emma's beat this take, in the room: "@Payables Read bill ${fresh}, check Oliver's address with the vendor check, and draft the payment."`);
  console.log(`\nrestored "${name}" (saved ${meta.savedAt}). Reload the app in both windows.`);
}

(async () => {
  const [cmd, name, who] = process.argv.slice(2);
  if (cmd === "list") {
    if (!existsSync(ROOT)) return console.log("no snapshots yet");
    for (const n of readdirSync(ROOT)) {
      const f = join(ROOT, n, "meta.json");
      if (existsSync(f)) {
        const m = JSON.parse(readFileSync(f, "utf8")) as Meta;
        console.log(`${n}  ${m.company}  saved ${m.savedAt}  ${existsSync(join(ROOT, n, "browser.json")) ? "with rooms" : "no rooms"}`);
      }
    }
  } else if ((cmd === "save" || cmd === "restore" || cmd === "rooms") && name && /^[a-z0-9-]+$/.test(name)) {
    if (cmd === "rooms") rooms(name, who);
    else await (cmd === "save" ? save(name) : restore(name));
  } else {
    console.log("usage: demo-state.ts save <name> | rooms <name> [emma] | restore <name> | list   (name: lowercase letters, digits, dashes)");
  }
  process.exit(0);
})().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  process.exit(1);
});
