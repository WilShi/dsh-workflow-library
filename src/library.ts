/**
 * Workflow discovery, parsing, and persistence.
 *
 * A workflow is a single `.js` file on disk: YAML frontmatter carrying the
 * identity block the engine requires, followed by the script body. Keeping it
 * as a plain file means workflows live in git, get code review, and can be
 * shared between teammates — none of which the inline, model-authored
 * `workflow` tool can do.
 *
 * ```js
 * ---
 * name: release-check
 * description: Check the repo before tagging a release
 * whenToUse: Right before cutting a version
 * ---
 * const files = args.files
 * const results = await Promise.all(files.map((f) => agent({ prompt: `Review ${f}` })))
 * return { results }
 * ```
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

/** Identity block carried by a workflow file, mirroring the engine's WorkflowMeta. */
export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  /**
   * Comma-separated phase titles in the frontmatter, exposed as progress
   * vocabulary to observers. The engine matches these against `phase()` calls by
   * exact string and imposes no execution structure from them.
   */
  phases?: string[];
  /** Free-text description of the arguments the script expects from `args`. */
  args?: string;
}

/** A workflow as discovered on disk, without its script body. */
export interface WorkflowEntry extends WorkflowMeta {
  /** Absolute path of the defining file. */
  path: string;
  /** Which root it came from, e.g. `project-dsh`. */
  source: string;
}

/** A fully loaded workflow, including the script body. */
export interface WorkflowDefinition extends WorkflowEntry {
  script: string;
}

interface Root {
  dir: string;
  source: string;
}

const WORKFLOW_EXT = ".js";

/**
 * Nearest ancestor containing `.git`; falls back to the starting directory.
 * Matches the convention the harness skill provider uses for project roots.
 */
export function findProjectRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/** Workflow roots in priority order: project first, then the user home. */
export function workflowRoots(cwd: string): Root[] {
  const projectRoot = findProjectRoot(cwd);
  const roots: Root[] = [
    { dir: join(projectRoot, ".dsh", "workflows"), source: "project-dsh" },
    { dir: join(projectRoot, ".agents", "workflows"), source: "project-agents" },
  ];
  const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  roots.push({ dir: join(dshHome, "workflows"), source: "user-dsh" });
  return roots;
}

/**
 * Split a workflow file into its frontmatter block and script body.
 *
 * An absent frontmatter block is not an error: the file name becomes the name
 * and the whole file is the script, which keeps trivial one-off workflows easy.
 */
export function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return { frontmatter: "", body: normalized };
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: "", body: normalized };
  return {
    frontmatter: normalized.slice(3, end).trim(),
    body: normalized.slice(end + 4).replace(/^\r?\n/, ""),
  };
}

/** Minimal YAML subset: `key: value` pairs, enough for the identity block. */
export function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Parse one workflow file. Returns null when the identity block is unusable. */
export function parseWorkflowFile(path: string, source: string, fallbackName: string): WorkflowDefinition | null {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  const { frontmatter, body } = splitFrontmatter(content);
  const meta = parseFrontmatter(frontmatter);
  const name = meta.name || fallbackName;
  if (!name) return null;
  const phases = (meta.phases ?? "")
    .split(",")
    .map((title) => title.trim())
    .filter(Boolean);
  return {
    name,
    description: meta.description || "",
    ...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}),
    ...(phases.length ? { phases } : {}),
    ...(meta.args ? { args: meta.args } : {}),
    path,
    source,
    script: body,
  };
}

/** Every workflow visible from `cwd`, first root wins on a name collision. */
export function discoverWorkflows(cwd: string): WorkflowEntry[] {
  const seen = new Set<string>();
  const found: WorkflowEntry[] = [];
  for (const root of workflowRoots(cwd)) {
    let names: string[];
    try {
      if (!statSync(root.dir).isDirectory()) continue;
      names = readdirSync(root.dir);
    } catch {
      continue;
    }
    for (const fileName of names.sort()) {
      if (!fileName.endsWith(WORKFLOW_EXT)) continue;
      const fallback = fileName.slice(0, -WORKFLOW_EXT.length);
      const def = parseWorkflowFile(join(root.dir, fileName), root.source, fallback);
      if (!def || seen.has(def.name)) continue;
      seen.add(def.name);
      found.push({
        name: def.name,
        description: def.description,
        ...(def.whenToUse ? { whenToUse: def.whenToUse } : {}),
        ...(def.phases ? { phases: def.phases } : {}),
        ...(def.args ? { args: def.args } : {}),
        path: def.path,
        source: def.source,
      });
    }
  }
  return found;
}

/** Load one workflow by name, or null when no root defines it. */
export function loadWorkflow(cwd: string, name: string): WorkflowDefinition | null {
  for (const root of workflowRoots(cwd)) {
    for (const candidate of [name + WORKFLOW_EXT]) {
      const path = join(root.dir, candidate);
      if (!existsSync(path)) continue;
      const def = parseWorkflowFile(path, root.source, name);
      if (def) return def;
    }
  }
  return null;
}

/** Persist a workflow into the project root, creating the directory if needed. */
export function saveWorkflow(cwd: string, meta: WorkflowMeta, script: string): string {
  const root = workflowRoots(cwd)[0];
  mkdirSync(root.dir, { recursive: true });
  const path = join(root.dir, meta.name + WORKFLOW_EXT);
  const frontmatter = [
    "---",
    "name: " + meta.name,
    "description: " + meta.description,
    ...(meta.whenToUse ? ["whenToUse: " + meta.whenToUse] : []),
    ...(meta.args ? ["args: " + meta.args] : []),
    ...(meta.phases?.length ? ["phases: " + meta.phases.join(", ")] : []),
    "---",
    "",
  ].join("\n");
  writeFileSync(path, frontmatter + script.replace(/^\r?\n/, "") + (script.endsWith("\n") ? "" : "\n"), "utf-8");
  return path;
}
