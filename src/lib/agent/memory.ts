/**
 * Agent memory as a small linked note graph (like an Obsidian vault), inside the agent's
 * workspace: memory/<slug>.md, each note short, with frontmatter and [[wikilinks]] to related
 * notes, plus an auto-maintained memory/INDEX.md (one line per note). The agent controls what
 * it writes; size caps keep any single note from growing without bound ("split and link").
 * Server-only.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxPaths } from "../sandbox";

export const MAX_NOTE_CHARS = 2000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,60}$/;

const memDir = (agent: string) => join(sandboxPaths(agent).workspace, "memory");

type Note = { slug: string; title: string; description: string; updated: string; links: string[]; body: string };

function parse(slug: string, raw: string): Note {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const fm: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const body = m?.[2] ?? raw;
  const links = [...new Set([...body.matchAll(/\[\[([a-z0-9][a-z0-9-]*)\]\]/g)].map((x) => x[1]))];
  return { slug, title: fm.title ?? slug, description: fm.description ?? "", updated: fm.updated ?? "", links, body };
}

function allNotes(agent: string): Note[] {
  const d = memDir(agent);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith(".md") && f !== "INDEX.md")
    .map((f) => parse(f.replace(/\.md$/, ""), readFileSync(join(d, f), "utf8")));
}

/** Rebuild memory/INDEX.md and return its text (what the agent is shown at session start). */
export function rebuildIndex(agent: string): { text: string; hash: string; count: number } {
  const notes = allNotes(agent).sort((a, b) => a.slug.localeCompare(b.slug));
  const slugs = new Set(notes.map((n) => n.slug));
  const lines = notes.map((n) => {
    const dangling = n.links.filter((l) => !slugs.has(l));
    return `- [[${n.slug}]] — ${n.description || n.title}${n.links.length ? ` (links: ${n.links.join(", ")})` : ""}${dangling.length ? ` [missing: ${dangling.join(", ")}]` : ""}`;
  });
  const text = `# Memory index (${notes.length} notes)\n${lines.join("\n") || "(empty — no memories yet)"}\n`;
  mkdirSync(memDir(agent), { recursive: true });
  writeFileSync(join(memDir(agent), "INDEX.md"), text);
  return { text, hash: createHash("sha256").update(text).digest("hex").slice(0, 16), count: notes.length };
}

export function memoryWrite(agent: string, slug: string, title: string, description: string, content: string) {
  if (!SLUG.test(slug)) throw new Error("slug must be lowercase letters, digits and dashes (e.g. 'vendor-lena')");
  if (content.length > MAX_NOTE_CHARS)
    throw new Error(`note too long (${content.length} > ${MAX_NOTE_CHARS} chars): split it into smaller notes linked with [[slug]]`);
  if (/\n/.test(description) || description.length > 160) throw new Error("description must be one line, max 160 chars");
  const file = join(memDir(agent), `${slug}.md`);
  const existed = existsSync(file);
  const fm = `---\ntitle: ${title.replace(/\n/g, " ")}\ndescription: ${description}\nupdated: ${new Date().toISOString().slice(0, 10)}\n---\n`;
  mkdirSync(memDir(agent), { recursive: true });
  writeFileSync(file, fm + content.trim() + "\n");
  const idx = rebuildIndex(agent);
  return { slug, action: existed ? "updated" : "created", notes: idx.count, links: parse(slug, content).links };
}

export function memoryRead(agent: string, slug: string) {
  if (!SLUG.test(slug)) throw new Error("bad slug");
  const file = join(memDir(agent), `${slug}.md`);
  if (!existsSync(file)) return { slug, exists: false };
  const n = parse(slug, readFileSync(file, "utf8"));
  const backlinks = allNotes(agent).filter((o) => o.links.includes(slug)).map((o) => o.slug);
  return { slug, exists: true, title: n.title, description: n.description, updated: n.updated, links: n.links, backlinks, body: n.body };
}

export function memorySearch(agent: string, query: string) {
  const q = query.toLowerCase();
  return allNotes(agent)
    .filter((n) => `${n.slug} ${n.title} ${n.description} ${n.body}`.toLowerCase().includes(q))
    .slice(0, 20)
    .map((n) => ({ slug: n.slug, description: n.description, links: n.links }));
}

/** Retire an outdated note: moved to memory/.archive (never hard-deleted). */
export function memoryArchive(agent: string, slug: string) {
  if (!SLUG.test(slug)) throw new Error("bad slug");
  const file = join(memDir(agent), `${slug}.md`);
  if (!existsSync(file)) return { slug, archived: false };
  mkdirSync(join(memDir(agent), ".archive"), { recursive: true });
  renameSync(file, join(memDir(agent), ".archive", `${slug}-${Date.now()}.md`));
  rebuildIndex(agent);
  return { slug, archived: true };
}
