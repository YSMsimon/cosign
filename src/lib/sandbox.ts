/**
 * Per-agent isolated workspace in a Docker Sandbox (a microVM with its own kernel).
 *
 * Host layout (SANDBOX_ROOT, default ~/.cosign/sandboxes/<agent>/):
 *   workspace/   READ-WRITE, mounted at the same path inside the VM
 *     memory/      notes that persist between runs
 *     work/        scratch (scripts, temp files)
 *     out/         results we collect
 *   context/     READ-ONLY mount (company policy, instructions, contacts snapshot, inbox)
 *
 * Commands run inside the VM as the non-root `agent` user. File read/write/edit is done on the
 * host side of the same mount with a path guard (context/ is read-only in code AND in the mount).
 * No secrets are ever passed into the sandbox. Server-only.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = process.env.SANDBOX_ROOT ?? join(homedir(), ".cosign", "sandboxes");
const MAX_OUT = 12_000;

export type SandboxPaths = { name: string; base: string; workspace: string; context: string };

export function sandboxPaths(agentRef: string): SandboxPaths {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(agentRef)) throw new Error(`bad agent ref "${agentRef}"`);
  const base = join(ROOT, agentRef);
  return { name: `cosign-${agentRef}`, base, workspace: join(base, "workspace"), context: join(base, "context") };
}

async function docker(args: string[], timeoutMs = 120_000) {
  return run("docker", ["sandbox", ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
}

async function status(name: string): Promise<"running" | "stopped" | "missing"> {
  const { stdout } = await docker(["ls"]);
  const line = stdout.split("\n").find((l) => l.trim().split(/\s+/)[0] === name);
  if (!line) return "missing";
  return /\brunning\b/.test(line) ? "running" : "stopped";
}

/**
 * Create (if needed) and start the agent's sandbox. `contextFiles` are (re)written into the
 * read-only context folder on every call, so the agent always sees the latest policy/contacts.
 */
export async function ensureSandbox(
  agentRef: string,
  contextFiles: Record<string, string> = {},
  opts: { network?: { policy: "allow" | "deny"; allowHosts?: string[] } } = {},
): Promise<SandboxPaths> {
  const p = sandboxPaths(agentRef);
  for (const d of ["memory", "work", "out"]) mkdirSync(join(p.workspace, d), { recursive: true });
  mkdirSync(p.context, { recursive: true });
  for (const [rel, content] of Object.entries(contextFiles)) {
    const target = guard(p, join(p.context, rel), "context-write-host");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  const s = await status(p.name);
  if (s === "missing") {
    await docker(["create", "--name", p.name, "-q", "shell", p.workspace, `${p.context}:ro`], 600_000);
  }
  if ((await status(p.name)) !== "running") {
    // `exec` starts a stopped sandbox VM on demand; a no-op command warms it up.
    await docker(["exec", p.name, "true"], 300_000);
  }
  if (opts.network) {
    const args = ["network", "proxy", p.name, "--policy", opts.network.policy];
    for (const h of opts.network.allowHosts ?? []) args.push("--allow-host", h);
    await docker(args);
  }
  return p;
}

export async function destroySandbox(agentRef: string) {
  const p = sandboxPaths(agentRef);
  if ((await status(p.name)) !== "missing") await docker(["rm", p.name]);
}

/** Run a shell command inside the agent's microVM (cwd = workspace). */
export async function sandboxExec(agentRef: string, command: string, timeoutSec = 60) {
  const p = sandboxPaths(agentRef);
  const t = Math.min(Math.max(timeoutSec, 1), 300);
  const started = Date.now();
  try {
    const { stdout, stderr } = await run(
      "docker",
      ["sandbox", "exec", "-w", p.workspace, p.name, "bash", "-lc", command],
      { timeout: t * 1000, maxBuffer: 8 * 1024 * 1024 },
    );
    return { exitCode: 0, stdout: cap(stdout), stderr: cap(stderr), ms: Date.now() - started };
  } catch (e: unknown) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    return {
      exitCode: typeof err.code === "number" ? err.code : -1,
      stdout: cap(err.stdout ?? ""),
      stderr: cap(err.stderr ?? "") + (err.killed ? `\n[killed after ${t}s timeout]` : ""),
      ms: Date.now() - started,
    };
  }
}

// ───────────── file tools (host side of the same mount, path-guarded) ─────────────

type Mode = "read" | "write" | "context-write-host";

function guard(p: SandboxPaths, path: string, mode: Mode): string {
  // accept workspace-relative paths ("out/x.json"), "context/..." shortcuts, or absolute VM paths
  let abs: string;
  if (path.startsWith("/")) abs = resolve(path);
  else if (path === "context" || path.startsWith("context/")) abs = resolve(p.context, path.replace(/^context\/?/, ""));
  else abs = resolve(p.workspace, path);
  const inWs = abs === p.workspace || !relative(p.workspace, abs).startsWith("..");
  const inCtx = abs === p.context || !relative(p.context, abs).startsWith("..");
  if (mode === "context-write-host" && inCtx) return abs;
  if (mode === "read" && (inWs || inCtx)) return abs;
  if (mode === "write" && inWs) return abs;
  if (mode === "write" && inCtx) throw new Error("context/ is read-only");
  throw new Error(`path outside the sandbox workspace: ${path}`);
}

export function readFile(agentRef: string, path: string, offset = 1, limit = 400) {
  const abs = guard(sandboxPaths(agentRef), path, "read");
  const lines = readFileSync(abs, "utf8").split("\n");
  const start = Math.max(1, offset);
  const slice = lines.slice(start - 1, start - 1 + Math.min(limit, 2000));
  return { path: abs, totalLines: lines.length, content: cap(slice.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join("\n")) };
}

export function writeFile(agentRef: string, path: string, content: string) {
  const abs = guard(sandboxPaths(agentRef), path, "write");
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return { path: abs, bytes: Buffer.byteLength(content) };
}

export function editFile(agentRef: string, path: string, oldText: string, newText: string, replaceAll = false) {
  const abs = guard(sandboxPaths(agentRef), path, "write");
  const src = readFileSync(abs, "utf8");
  const count = src.split(oldText).length - 1;
  if (count === 0) throw new Error("old_text not found");
  if (count > 1 && !replaceAll) throw new Error(`old_text matches ${count} times; make it unique or set replace_all`);
  writeFileSync(abs, replaceAll ? src.split(oldText).join(newText) : src.replace(oldText, newText));
  return { path: abs, replacements: replaceAll ? count : 1 };
}

export function listDir(agentRef: string, path = ".") {
  const abs = guard(sandboxPaths(agentRef), path, "read");
  if (!existsSync(abs)) return { path: abs, entries: [] };
  return {
    path: abs,
    entries: readdirSync(abs).slice(0, 500).map((n) => {
      const st = statSync(join(abs, n));
      return { name: n, type: st.isDirectory() ? "dir" : "file", bytes: st.isDirectory() ? undefined : st.size };
    }),
  };
}

const cap = (s: string) => (s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n…[truncated ${s.length - MAX_OUT} chars]` : s);
