/**
 * Transcript discovery, scanning and rendering.
 *
 * This mirrors src/context_find/store.py, which stays the canonical implementation
 * and is the copy shipped to remote machines over ssh. test/golden.test.ts
 * renders the same fixture through both and fails if they ever drift.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, sep } from "node:path";
import { debug } from "./debug.ts";

/** Preambles Claude Code injects into a user turn. Never what the human typed. */
const SKIP_PREFIXES = [
  "<local-command-caveat>", "<local-command-stdout>", "<command-name>",
  "<command-message>", "<command-args>", "<system-reminder>",
  "<ide_opened_file>", "<ide_selection>", "Caveat: The messages below",
];

const ARG_KEYS = ["command", "file_path", "pattern", "path", "query", "url",
                  "description", "prompt", "skill"];

const ANSI_ESCAPE_RE =
  /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)?|[P^_][^\x07\x1b]*(?:\x07|\x1b\\)?|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

export function sanitizeTerminalText(text: string): string {
  if (!text) return "";
  return text.replace(ANSI_ESCAPE_RE, "");
}

/** Codex injects its own wrappers into the user turn. */
const CODEX_SKIP_PREFIXES = [
  "# AGENTS.md instructions", "<environment_context>", "<user_instructions>",
  "<INSTRUCTIONS>", "<recommended_plugins>",
];

export const SOURCES = ["claude", "codex"] as const;
export type Source = (typeof SOURCES)[number];

export type Style = "user" | "assistant" | "tool" | "meta" | "text";
export type Line = [Style, string];

export interface Session {
  path: string;
  cwd: string;
  branch: string;
  summary: string;
  mtime: number;
  host: string | null;
  source: Source;
  sid: string;
}

export function sessionId(session: Session): string {
  // Codex file names are rollout-<timestamp>-<uuid>, so the id comes from
  // session_meta instead of the stem.
  return session.sid || basename(session.path).replace(/\.jsonl$/, "");
}

/** Codex rollout store. CODEX_HOME wins, as the Codex CLI itself does. */
export function codexRoots(): string[] {
  const base = process.env["CODEX_HOME"];
  const root = join(base ?? join(homedir(), ".codex"), "sessions");
  return isDir(root) ? [root] : [];
}

/** Every transcript store on this machine, CLAUDE_CONFIG_DIR first. */
export function projectsRoots(): string[] {
  const roots: string[] = [];
  const base = process.env["CLAUDE_CONFIG_DIR"];
  const candidates = base ? [base, join(homedir(), ".claude")] : [join(homedir(), ".claude")];
  for (const candidate of candidates) {
    const root = join(candidate, "projects");
    if (!roots.includes(root) && isDir(root)) roots.push(root);
  }
  return roots;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

type Found = [path: string, source: Source];

export function transcripts(root?: string): Found[] {
  if (root) {
    const paths: string[] = [];
    walk(root, paths);
    return paths.map((path) => [path, "claude"] as Found);
  }
  const found: Found[] = [];
  for (const base of projectsRoots()) {
    const paths: string[] = [];
    walk(base, paths);
    found.push(...paths.map((path) => [path, "claude"] as Found));
  }
  for (const base of codexRoots()) {
    const paths: string[] = [];
    walk(base, paths);
    found.push(...paths
      .filter((path) => basename(path).startsWith("rollout-"))
      .map((path) => [path, "codex"] as Found));
  }
  return found;
}

export function conversationCounts(): Record<string, number> {
  const tally: Record<string, number> = { claude: 0, codex: 0, last: 0 };
  for (const [path, source] of transcripts()) {
    tally[source] = (tally[source] ?? 0) + 1;
    try {
      tally["last"] = Math.max(tally["last"]!, statSync(path).mtimeMs / 1000);
    } catch { /* skip unreadable file */ }
  }
  return tally;
}

export function relativeTime(stamp?: number, now?: number): string {
  if (!stamp) return "never";
  const gap = Math.max((now ?? Date.now() / 1000) - stamp, 0);
  const steps: [number, number, string][] = [
    [90, 1, "second"], [5400, 60, "minute"], [172800, 3600, "hour"],
    [1209600, 86400, "day"], [7776000, 604800, "week"],
  ];
  for (const [limit, size, unit] of steps) {
    if (gap < limit) {
      const count = Math.max(Math.trunc(gap / size), 1);
      return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
    }
  }
  const count = Math.max(Math.trunc(gap / 2592000), 1);
  return `${count} month${count === 1 ? "" : "s"} ago`;
}

/** Codex rollouts open with a session_meta line; Claude transcripts do not. */
export function detectSource(path: string): Source {
  try {
    const head = readFileSync(path, "utf8").slice(0, 400);
    return head.includes('"session_meta"') ? "codex" : "claude";
  } catch {
    return "claude";
  }
}

function codexText(payload: Record<string, any>): string {
  return (payload["content"] ?? [])
    .filter((b: any) => b && typeof b === "object" &&
      ["input_text", "output_text", "text"].includes(b.type))
    .map((b: any) => b.text ?? "")
    .join("\n");
}

function startsWithCodexSkipped(text: string): boolean {
  return CODEX_SKIP_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function walk(dir: string, found: string[]): void {
  let items;
  try {
    items = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of items) {
    const path = join(dir, item.name);
    // subagent sidechains have no session of their own to resume; claude-mem's
    // observer sessions are bot chatter under ~/.claude-mem, not real conversations
    if (item.isDirectory()) {
      if (item.name !== "subagents" && !item.name.includes("claude-mem-observer-sessions")) walk(path, found);
    } else if (item.name.endsWith(".jsonl")) {
      found.push(path);
    }
  }
}

function entries(path: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push(parsed);
      }
    } catch {
      /* a partially written line is not fatal */
    }
  }
  return out;
}

function plainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === "object" && b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
  }
  return "";
}

function startsWithSkipped(text: string): boolean {
  return SKIP_PREFIXES.some((prefix) => text.startsWith(prefix));
}

type Header = [cwd: string, branch: string, summary: string, sid: string];

/** Header from the first real user turn, or null. */
export function header(path: string, source?: Source): Header | null {
  if ((source ?? detectSource(path)) === "codex") return codexHeader(path);
  let cwd: string | null = null;
  let branch = "-";
  for (const entry of entries(path)) {
    if (entry["type"] !== "user" || !entry["cwd"]) continue;
    cwd = entry["cwd"];
    branch = entry["gitBranch"] || "-";
    const body = plainText(entry["message"]?.content).trim();
    if (cwd && body && !startsWithSkipped(body)) {
      return [cwd, branch, sanitizeTerminalText(body.split(/\s+/).join(" ")), stem(path)];
    }
  }
  return cwd ? [cwd, branch, "(no prompt text)", stem(path)] : null;
}

function stem(path: string): string {
  return basename(path).replace(/\.jsonl$/, "");
}

function codexHeader(path: string): Header | null {
  let cwd: string | null = null;
  let sid = "";
  for (const entry of entries(path)) {
    const payload = entry["payload"] ?? {};
    if (entry["type"] === "session_meta") {
      cwd = payload.cwd ?? null;
      sid = payload.session_id ?? payload.id ?? "";
      continue;
    }
    if (entry["type"] === "response_item" && payload.type === "message" &&
        payload.role === "user") {
      const body = codexText(payload).trim();
      if (cwd && body && !startsWithCodexSkipped(body)) {
        return [cwd, "-", sanitizeTerminalText(body.split(/\s+/).join(" ")), sid];
      }
    }
  }
  return cwd ? [cwd, "-", "(no prompt text)", sid] : null;
}

function stripReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ");
}

/** Text of the real conversation only - what the human typed and what the agent
 *  replied. Tool output, reasoning, and every injected block (skill catalogs,
 *  system reminders, session boilerplate) are left out, so a search for
 *  "elastic" finds sessions that actually discuss it, not ones that merely carry
 *  the aws-containers skill blurb. Original case; callers lowercase to match. */
function searchText(path: string, source: Source): string {
  const parts: string[] = [];
  if (source === "codex") {
    for (const entry of entries(path)) {
      const p = entry["payload"] ?? {};
      if (entry["type"] !== "response_item" || p.type !== "message") continue;
      if (p.role !== "user" && p.role !== "assistant") continue;
      const t = codexText(p).trim();
      if (t && !(p.role === "user" && startsWithCodexSkipped(t))) parts.push(t);
    }
  } else {
    for (const entry of entries(path)) {
      const role = entry["type"];
      if (role !== "user" && role !== "assistant") continue;
      let t = plainText(entry["message"]?.content).trim();
      if (!t) continue;
      if (role === "user") {
        t = stripReminders(t).trim();
        if (!t || startsWithSkipped(t)) continue;
      }
      parts.push(t);
    }
  }
  return parts.join("\n");
}

/** The line the query sits on, whitespace-collapsed and windowed to ~140 chars
 *  around the hit, for the row preview. Kept identical to store.py _snippet. */
function matchSnippet(text: string, needle: string): string | null {
  const i = text.toLowerCase().indexOf(needle);
  if (i < 0) return null;
  const start = text.lastIndexOf("\n", i) + 1;
  let end = text.indexOf("\n", i);
  if (end < 0) end = text.length;
  const line = text.slice(start, end).replace(/\s+/g, " ").trim();
  const MAX = 140;
  if (line.length <= MAX) return sanitizeTerminalText(line);
  const at = line.toLowerCase().indexOf(needle);
  const from = Math.max(0, at - 40);
  const clip = line.slice(from, from + MAX);
  return sanitizeTerminalText((from > 0 ? "…" : "") + clip + (from + MAX < line.length ? "…" : ""));
}

export function searchLocalTranscripts(query = "", root?: string): Session[] {
  const started = Date.now();
  const needle = query.toLowerCase();
  const candidates = transcripts(root);
  const found: Session[] = [];
  let skipped = 0;
  let errors = 0;
  for (const [path, source] of candidates) {
    try {
      let summary: string | null = null;
      if (needle) {
        const text = searchText(path, source);
        if (!text.toLowerCase().includes(needle)) {
          skipped += 1;
          continue;
        }
        summary = matchSnippet(text, needle);
      }
      const head = header(path, source);
      if (!head) {
        skipped += 1;
        continue;
      }
      found.push({
        path, cwd: head[0], branch: head[1], summary: summary ?? head[2],
        mtime: statSync(path).mtimeMs / 1000, host: null, source, sid: head[3],
      });
    } catch {
      /* unreadable file, skip */
      errors += 1;
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  debug(`local scan completed: ${candidates.length} candidates, ${found.length} matched, ${skipped} skipped, ${errors} errors, ${Date.now() - started}ms`);
  return found;
}

function toolArg(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  for (const key of ARG_KEYS) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value.split(/\s+/).join(" ");
  }
  return "";
}

function timeOfDay(stamp: unknown): string {
  if (typeof stamp !== "string" || stamp.length < 16) return "";
  const moment = new Date(stamp);
  if (Number.isNaN(moment.getTime())) return stamp.slice(11, 16);
  return String(moment.getHours()).padStart(2, "0") + ":" +
         String(moment.getMinutes()).padStart(2, "0");
}

const BLANK = /^\s+$/;

/**
 * Greedy wrap matching Python textwrap.wrap defaults, which store.py uses.
 * Whitespace runs inside a line are preserved, dropped at a line break, and
 * a word longer than the width is broken rather than left to overflow.
 */
function wrap(text: string, width: number): string[] {
  const chunks = text.split(/(\s+)/).filter((chunk) => chunk !== "");
  const lines: string[] = [];
  let current: string[] = [];
  let length = 0;

  const flush = () => {
    while (current.length && BLANK.test(current[current.length - 1]!)) current.pop();
    const line = current.join("");
    if (line) lines.push(line);
    current = [];
    length = 0;
  };

  for (const chunk of chunks) {
    if (current.length === 0 && BLANK.test(chunk)) continue;
    if (length + chunk.length <= width) {
      current.push(chunk);
      length += chunk.length;
      continue;
    }
    flush();
    if (BLANK.test(chunk)) continue;
    let rest = chunk;
    while (rest.length > width) {
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    if (rest) {
      current = [rest];
      length = rest.length;
    }
  }
  flush();
  return lines.length ? lines : [""];
}

export function renderTranscript(path: string, width = 100, showAll = false, asciiOnly = false,
                       source?: Source): Line[] {
  if ((source ?? detectSource(path)) === "codex") {
    return renderCodex(path, width, showAll, asciiOnly);
  }
  const [bar, gear, arrow] = asciiOnly ? ["-", "*", "->"] : ["─", "⚙", "⤷"];
  const cols = Math.max(Math.trunc(width), 30);
  const out: Line[] = [];

  const speaker = (label: string, stamp: string, style: Style) => {
    const tail = stamp ? "  " + stamp : "";
    const fill = Math.max(cols - label.length - tail.length - 5, 3);
    if (out.length) out.push(["meta", ""]);
    out.push([style, bar!.repeat(2) + " " + label + " " + bar!.repeat(fill) + tail]);
  };

  const body = (text: string) => {
    for (const para of sanitizeTerminalText(text).split("\n")) {
      if (!para.trim()) {
        out.push(["text", ""]);
        continue;
      }
      for (const line of wrap(para, cols - 4)) out.push(["text", "   " + line]);
    }
  };

  for (const entry of entries(path)) {
    const kind = entry["type"];
    const stamp = timeOfDay(entry["timestamp"]);
    const message = entry["message"];
    const msgObj = (message && typeof message === "object") ? message : {};
    const content = msgObj.content;

    if (kind === "user") {
      const results = Array.isArray(content)
        ? content.filter((b) => b && typeof b === "object" && b.type === "tool_result")
        : [];
      const text = plainText(content).trim();
      if (results.length && !text) {
        if (showAll) {
          for (const block of results) {
            const size = String(block.content ?? "").length;
            out.push(["meta", `   ${arrow} result, ${size} chars`]);
          }
        }
        continue;
      }
      if (!text || (startsWithSkipped(text) && !showAll)) continue;
      speaker("You", stamp, "user");
      body(text);
    } else if (kind === "assistant") {
      for (const block of Array.isArray(content) ? content : []) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && (block.text ?? "").trim()) {
          speaker("Claude", stamp, "assistant");
          body(String(block.text).trim());
        } else if (block.type === "tool_use") {
          const toolName = sanitizeTerminalText(String(block.name ?? "?"));
          const toolInput = sanitizeTerminalText(toolArg(block.input));
          const line = `   ${gear} ${toolName}  ${toolInput}`;
          out.push(["tool", line.slice(0, cols - 1)]);
        }
      }
    } else if (showAll) {
      out.push(["meta", "   · " + String(kind)]);
    }
  }

  return out.length ? out : [["meta", "(nothing to show)"]];
}

/** Codex rollouts: response_item envelopes rather than Claude's flat turns. */
function renderCodex(path: string, width: number, showAll: boolean,
                     asciiOnly: boolean): Line[] {
  const [bar, gear] = asciiOnly ? ["-", "*"] : ["─", "⚙"];
  const cols = Math.max(Math.trunc(width), 30);
  const out: Line[] = [];

  const speaker = (label: string, stamp: string, style: Style) => {
    const tail = stamp ? "  " + stamp : "";
    const fill = Math.max(cols - label.length - tail.length - 5, 3);
    if (out.length) out.push(["meta", ""]);
    out.push([style, bar!.repeat(2) + " " + label + " " + bar!.repeat(fill) + tail]);
  };

  const body = (text: string) => {
    for (const para of sanitizeTerminalText(text).split("\n")) {
      if (!para.trim()) {
        out.push(["text", ""]);
        continue;
      }
      for (const line of wrap(para, cols - 4)) out.push(["text", "   " + line]);
    }
  };

  for (const entry of entries(path)) {
    const kind = entry["type"];
    const payload = entry["payload"] ?? {};
    const stamp = timeOfDay(entry["timestamp"]);

    if (kind === "response_item" && payload.type === "message") {
      const text = codexText(payload).trim();
      if (!text) continue;
      if (payload.role === "user") {
        if (startsWithCodexSkipped(text) && !showAll) continue;
        speaker("You", stamp, "user");
        body(text);
      } else if (payload.role === "assistant") {
        speaker("Codex", stamp, "assistant");
        body(text);
      } else if (showAll) {
        speaker(String(payload.role), stamp, "meta");
        body(text);
      }
    } else if (kind === "response_item" &&
               ["function_call", "custom_tool_call", "local_shell_call"].includes(payload.type)) {
      const args = sanitizeTerminalText(String(payload.arguments ?? payload.input ?? "").split(/\s+/).join(" "));
      const toolName = sanitizeTerminalText(String(payload.name ?? "?"));
      const line = `   ${gear} ${toolName}  ${args}`;
      out.push(["tool", line.slice(0, cols - 1)]);
    } else if (showAll && kind === "response_item") {
      out.push(["meta", "   · " + String(payload.type)]);
    }
  }

  return out.length ? out : [["meta", "(nothing to show)"]];
}

export function prettyPath(cwd: string): string {
  const home = sanitizeTerminalText(homedir()).split(sep).join("/");
  const folder = sanitizeTerminalText(cwd).split("\\").join("/");
  return folder.startsWith(home) ? "~" + folder.slice(home.length) : folder;
}
