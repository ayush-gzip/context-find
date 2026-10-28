import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** One entry of the message box's / menu. */
export interface SlashCommand {
  name: string;
  description?: string;
  /** What to type after the name, from the file's `argument-hint`. */
  hint?: string;
  /** Works only in an interactive terminal, not in a dashboard agent. */
  terminal?: boolean;
  skillPath?: string;
}

/** Codex exposes controls through RPC, rather than interpreting TUI slash text. */
export async function codexCommands(rpc: { call: (method: string, params?: any) => Promise<any> }, cwd: string): Promise<SlashCommand[]> {
  const models: any[] = [];
  let cursor: string | undefined;
  do {
    const page = await rpc.call("model/list", { limit: 100, ...(cursor ? { cursor } : {}) });
    models.push(...page.data);
    cursor = page.nextCursor || undefined;
  } while (cursor);
  const skills = await rpc.call("skills/list", { cwds: [cwd] });
  const efforts = new Set<string>(models.flatMap(m => (m.supportedReasoningEfforts || []).map((e: any) => e.reasoningEffort)));
  return [
    { name: "model", description: "Choose a model", hint: "name" },
    ...models.filter(m => !m.hidden).map(m => ({ name: `model ${m.model}`, description: m.displayName || m.model })),
    { name: "effort", description: "Set reasoning effort", hint: "level" },
    ...[...efforts].map(e => ({ name: `effort ${e}`, description: `Use ${e} reasoning effort` })),
    { name: "compact", description: "Compact this conversation" },
    { name: "status", description: "Show this session's model and state" },
    { name: "rename", description: "Rename this conversation", hint: "title" },
    { name: "stop", description: "Stop the current reply" },
    { name: "skills", description: "List available skills" },
    ...skills.data.flatMap((entry: any) => (entry.skills || [])
      .filter((s: any) => s.enabled && !["model", "effort", "compact", "status", "rename", "stop", "skills"].includes(s.name))
      .map((s: any) => ({ name: s.name, description: s.shortDescription || s.description, skillPath: s.path }))),
  ];
}

// Claude's own commands have no file to read a description from.
const BUILT_IN: Record<string, string> = {
  agents: "Manage subagents",
  clear: "Start a new conversation",
  compact: "Summarize the conversation to free up context",
  config: "Open settings",
  context: "Show what fills the context window",
  doctor: "Check the Claude Code install",
  effort: "Change the reasoning effort",
  fast: "Turn fast mode on or off",
  init: "Write a CLAUDE.md for this project",
  mcp: "Manage MCP servers",
  model: "Change the model",
  "output-style": "Change the output style",
  "reload-plugins": "Reload plugins",
  "reload-skills": "Reload skills",
  rename: "Rename this session",
  "security-review": "Review the pending changes for security issues",
  usage: "Show plan usage limits",
};
const TTL = 10 * 60_000,
  cache = new Map<string, { at: number; list: Promise<SlashCommand[]> }>();

/** Claude's commands for a config folder and project, cached for ten minutes. */
export function claudeCommands(
  env: NodeJS.ProcessEnv,
  configDir: string,
  cwd: string,
): Promise<SlashCommand[]> {
  const key = configDir + "\0" + cwd,
    hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.list;
  const list = probe(env, cwd).then((init) => build(init, configDir, cwd));
  list.catch(() => cache.delete(key));
  cache.set(key, { at: Date.now(), list });
  return list;
}

function probe(env: NodeJS.ProcessEnv, cwd: string): Promise<any> {
  return new Promise((resolve, reject) => {
    // `/cost` runs inside Claude Code: the init event that lists the commands
    // comes first, and no model is called. Hooks and MCP servers stay off.
    const child = spawn(
        process.env["CFIND_CLAUDE_BIN"] ?? "claude",
        [
          "-p",
          "/cost",
          "--output-format",
          "stream-json",
          "--verbose",
          "--no-session-persistence",
          "--strict-mcp-config",
          "--settings",
          '{"disableAllHooks":true}',
        ],
        { cwd, env, stdio: ["ignore", "pipe", "ignore"] },
      ),
      fail = () => reject(new Error("Claude did not list its commands")),
      timer = setTimeout(() => {
        child.kill();
        fail();
      }, 20_000);
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const e = JSON.parse(line);
        if (e.type !== "system" || e.subtype !== "init") return;
        clearTimeout(timer);
        child.kill();
        resolve(e);
      } catch {}
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      fail();
    });
  });
}

function build(init: any, configDir: string, cwd: string) {
  const known = new Map<string, SlashCommand>();
  scan(configDir, "", known);
  scan(join(cwd, ".claude"), "", known);
  for (const p of Array.isArray(init.plugins) ? init.plugins : [])
    if (typeof p?.path === "string" && typeof p?.name === "string")
      scan(p.path, p.name + ":", known);
  const terminal = new Set(init.terminal_slash_commands ?? []);
  return (Array.isArray(init.slash_commands) ? init.slash_commands : [])
    .filter((n: unknown) => typeof n === "string" && !n.startsWith("__"))
    .map((name: string): SlashCommand => ({
      ...(known.get(name) ??
        (BUILT_IN[name] ? { description: BUILT_IN[name] } : {})),
      name,
      ...(terminal.has(name) ? { terminal: true } : {}),
    }));
}

/** Skills and command files in one folder; plugin entries get "plugin:" in front. */
function scan(dir: string, prefix: string, into: Map<string, SlashCommand>) {
  const add = (fallback: string, file: string) => {
    const f = frontmatter(file),
      name = prefix + (f["name"] || fallback);
    into.set(name, {
      name,
      ...(f["description"]
        ? { description: f["description"].slice(0, 200) }
        : {}),
      ...(f["argument-hint"] ? { hint: f["argument-hint"].slice(0, 80) } : {}),
    });
  };
  for (const skill of list(join(dir, "skills")))
    add(skill, join(dir, "skills", skill, "SKILL.md"));
  for (const file of list(join(dir, "commands")))
    if (file.endsWith(".md"))
      add(file.slice(0, -3), join(dir, "commands", file));
}

const list = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** The flat `key: value` lines of a Markdown file's YAML header. */
export function frontmatter(file: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (!head) return {};
  const out: Record<string, string> = {},
    lines = head.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    // `>` and `|` blocks continue on the indented lines below.
    if (/^[>|][-+]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && /^(\s|$)/.test(lines[i + 1]!))
        block.push(lines[++i]!.trim());
      value = block.join(" ").trim();
    }
    out[kv[1]!] = value.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}
