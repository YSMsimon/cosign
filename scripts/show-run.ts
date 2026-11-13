/** Pretty-print an agent run log. Usage: pnpm tsx scripts/show-run.ts [runId | path | latest] */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const arg = process.argv[2] ?? "latest";
const root = join(process.env.LOG_DIR ?? "logs", "runs");
const files = readdirSync(root).flatMap((d) => readdirSync(join(root, d)).map((f) => join(root, d, f)));
const file =
  arg === "latest" ? files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] : files.find((f) => f.includes(arg)) ?? arg;

for (const line of readFileSync(file, "utf8").trim().split("\n")) {
  const { runId: _r, seq: _s, t: _t, ms, type, ...rest } = JSON.parse(line);
  const body = JSON.stringify(rest);
  console.log(`${String(ms).padStart(6)}ms  ${String(type).padEnd(15)} ${body.length > 300 ? body.slice(0, 300) + "…" : body}`);
}
console.log(`\n(${file})`);
