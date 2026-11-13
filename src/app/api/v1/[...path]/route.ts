import { connection } from "next/server";
import { handle } from "@/lib/server/router";

// Cosign backend API (/api/v1/...). Endpoints and rules: src/lib/server/router.ts.
type Ctx = { params: Promise<{ path: string[] }> };

async function serve(req: Request, ctx: Ctx) {
  await connection(); // always dynamic: every answer depends on the caller and live state
  const { path } = await ctx.params;
  return handle(req, path);
}

export const GET = serve;
export const POST = serve;
export const PATCH = serve;
export const DELETE = serve;
