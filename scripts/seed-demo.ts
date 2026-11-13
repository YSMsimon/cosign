/**
 * Put the demo treasury into a workspace: "Nova Labs" with the Test CFO as All access, Lena as a
 * saved payee, the existing Clerk (team agent, can draft) and an Auditor (team agent, read-only).
 * Optional COSIGN_OWNER_ADDRESS (your own wallet) is invited as All access too.
 * Safe to re-run. Run: pnpm tsx --env-file=.env.local scripts/seed-demo.ts
 */
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import type { Address } from "viem";
import { createCircleWallet, wallet } from "../src/lib/arc";
import { DEFAULT_CONTROLS, mergeControls, PRESETS } from "../src/lib/agent/rules";
import { db, schema } from "../src/lib/db";
import { createWorkspace } from "../src/lib/server/workspaces";
import { id } from "../src/lib/server/util";

(async () => {
  const treasury = (JSON.parse(readFileSync("data/treasury.local.json", "utf8")).treasury as string).toLowerCase();
  const cfo = wallet("test-cfo").address.toLowerCase();
  const lena = (process.env.DEPLOYER_ADDRESS as string).toLowerCase();
  const now = () => new Date().toISOString();

  let ws = db().select().from(schema.workspaces).where(eq(schema.workspaces.treasury, treasury)).get();
  if (!ws) {
    ws = await createWorkspace(cfo, { name: "Nova Labs", treasury, title: "CFO" });
    console.log(`1. workspace "Nova Labs" (${ws.id}) for treasury ${treasury}, Test CFO = All access`);
  } else console.log(`1. workspace exists: ${ws.name} (${ws.id})`);
  const roles = db().select().from(schema.roles).where(eq(schema.roles.workspaceId, ws.id)).all();
  const allAccess = roles.find((r) => r.key === "all_access")!;
  const cfoMember = db().select().from(schema.members).where(and(eq(schema.members.workspaceId, ws.id), eq(schema.members.address, cfo))).get()!;

  const owner = process.env.COSIGN_OWNER_ADDRESS?.toLowerCase();
  if (owner && !db().select().from(schema.members).where(and(eq(schema.members.workspaceId, ws.id), eq(schema.members.address, owner))).get()) {
    db().insert(schema.members).values({ id: id("mem"), workspaceId: ws.id, address: owner, roleId: allAccess.id, title: "Founder", invitedBy: cfo, createdAt: now(), joinedAt: null }).run();
    console.log(`2. invited your wallet ${owner} as All access (to cosign, also run: pnpm cosign add-approver ${owner})`);
  } else console.log(`2. ${owner ? "your wallet is already a member" : "set COSIGN_OWNER_ADDRESS to invite your own wallet"}`);

  if (!db().select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, ws.id), eq(schema.contacts.address, lena))).get()) {
    db().insert(schema.contacts).values({ id: id("con"), workspaceId: ws.id, name: "Lena (contractor)", address: lena, notes: "Frontend contractor, paid weekly", createdBy: cfo, createdAt: now() }).run();
  }
  console.log("3. saved payee: Lena (contractor)");

  const ensureAgent = async (ref: string, name: string, prompt: string, preset: keyof typeof PRESETS, controls: object) => {
    const existing = db().select().from(schema.agents).where(eq(schema.agents.ref, ref)).get();
    if (existing) return existing;
    let w: { id: string; address: Address };
    try {
      w = wallet(ref); // the Clerk keeps its existing wallet, nanopayment balance and microVM
    } catch {
      w = await createCircleWallet(ref, `${name} Nova Labs`);
    }
    const row = {
      id: id("ag"),
      workspaceId: ws!.id,
      name,
      prompt,
      visibility: "team",
      allowedRoleIds: null,
      ownerMemberId: cfoMember.id,
      abilities: JSON.stringify(PRESETS[preset]),
      controls: JSON.stringify(mergeControls(DEFAULT_CONTROLS, controls)),
      ref,
      walletId: w.id,
      walletAddress: w.address.toLowerCase(),
      status: "active",
      createdAt: now(),
      updatedAt: now(),
    };
    db().insert(schema.agents).values(row).run();
    return row;
  };
  const clerk = await ensureAgent("agent-ap-clerk", "Clerk", "You handle payables: read invoices, check vendors, and draft payments for a human to cosign.", "clerk", {
    allowedSellers: ["localhost:3000/api/sellers", "x402.quicknode.com"],
    allowedPayees: [lena],
    pettyCashPerWeekUsd: 2,
  });
  const auditor = await ensureAgent("agent-auditor", "Auditor", "You review the company's finances and report findings. You never spend, draft or draw petty cash.", "readonly", {});
  console.log(`4. agents: Clerk ${clerk.id} (team, can draft; wallet ${clerk.walletAddress}), Auditor ${auditor.id} (team, read-only)`);
  console.log(`\nworkspace id: ${ws.id}`);
})().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  process.exit(1);
});
