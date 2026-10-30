import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { monitorDir, type Profile } from "./monitor.ts";
import { claudeCommands, codexCommands } from "./commands.ts";
import { CodexRPC } from "./codex.ts";
import { formFields, formContent } from "./elicitation.ts";
import { uploadPath, uploadType } from "./uploads.ts";
import { startInTmux } from "./live.ts";
import { askCommand, askReply } from "./asks.ts";
import { recordSignal } from "./collector.ts";

export interface Message {
  id: string;
  role: string;
  text: string;
  time: number;
  tool?: { name: string; input: string; output?: string; error?: boolean };
  /** Upload ids of images sent with a user message. */
  images?: string[];
}
export interface QueueItem {
  text: string;
  images?: string[];
  skill?: { name: string; path: string };
}
export interface Child {
  id: string;
  task: string;
  state: string;
  model?: string;
  updatedAt: number;
}
export interface Agent {
  id: string;
  profile: string;
  cwd: string;
  title: string;
  sid?: string;
  history?: string;
  turnId?: string;
  model?: string;
  /** Set with `/model`; Claude starts with it again after a restart. */
  pickedModel?: string;
  permissionMode?: "auto" | "manual";
  /** A session that cfind joined on the shared server. Its transcript remains primary. */
  external?: boolean;
  effort?: string;
  state: string;
  startedAt: number;
  updatedAt: number;
  messages: Message[];
  queue: QueueItem[];
  children: Child[];
  error?: string;
  estimatedCostUsd?: number;
  pending?: { id: any; method: string; params: any };
  /** The turn ended and the agent waits for the user's answer to this. */
  ask?: string;
}
export function newAgent(profile: string, cwd: string, title: string): Agent {
  return {
    id: randomUUID(),
    profile,
    cwd,
    title: title.slice(0, 100),
    permissionMode: "auto",
    state: "queued",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    queue: [],
    children: [],
  };
}
function push(
  a: Agent,
  role: string,
  text: string,
  id: string = randomUUID(),
  images?: string[],
) {
  a.messages.push({ id, role, text, time: Date.now(), images });
  a.messages = a.messages.slice(-250);
}
const clip = (text: string) =>
  text.length > 8000 ? text.slice(0, 8000) + "\n…" : text;
/** A tmux server keeps its own PATH, so the terminal gets Claude's full path. */
function claudeBin() {
  const name = process.env["CFIND_CLAUDE_BIN"] ?? "claude";
  if (name.includes("/")) return name;
  const dirs = [
    ...(process.env["PATH"] ?? "").split(":"),
    join(homedir(), ".local", "bin"),
  ];
  return dirs.map((d) => join(d, name)).find((p) => existsSync(p)) ?? name;
}
const SHELL_MS = 2 * 60 * 1000,
  SHELL_OUTPUT = 30000;
/** Codex keeps the approval policy on the thread; "untrusted" asks before commands. */
const codexMode = (policy: unknown): Agent["permissionMode"] =>
  policy === "untrusted" ? "manual" : "auto";
const codexPolicy = (a: Agent) =>
  a.permissionMode === "manual" ? "untrusted" : "on-request";
// Claude's own terminal escapes these in `!` output.
const escapeTags = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function pushTool(
  a: Agent,
  id: string,
  name: string,
  summary: string,
  input: unknown,
) {
  const text =
    typeof input === "string" ? input : JSON.stringify(input ?? {}, null, 2);
  if (a.messages.some((m) => m.id === id)) return;
  push(a, "tool", summary.split(/\s+/).join(" ").slice(0, 300), id);
  a.messages[a.messages.length - 1]!.tool = { name, input: clip(text) };
}
/** At the end of a turn: the agent's own `cfind ask` call, else its last paragraph. */
function setAsk(a: Agent) {
  let start = a.messages.length;
  while (start > 0 && a.messages[start - 1]!.role !== "user") start--;
  let ask: string | undefined, reply: string | undefined;
  for (const m of a.messages.slice(start)) {
    if (m.role === "assistant" && m.text.trim()) reply = m.text;
    if (m.role !== "tool" || !m.tool) continue;
    // Claude's input is JSON with a command; Codex's is the command itself.
    let command = m.tool.input;
    try {
      command = JSON.parse(command).command ?? command;
    } catch {}
    if (typeof command === "string") ask = askCommand(command) ?? ask;
  }
  ask ??= askReply(reply);
  if (ask) a.ask = ask;
  else delete a.ask;
}
function toolOutput(a: Agent, id: string, output: string, error = false) {
  const m = a.messages.find((m) => m.id === id);
  if (m?.tool) {
    m.tool.output = clip(output);
    m.tool.error = error || undefined;
  }
}
const toolSummary = (input: any) =>
  [
    "command",
    "file_path",
    "pattern",
    "path",
    "query",
    "url",
    "description",
    "prompt",
  ]
    .map((k) => input?.[k])
    .find((v) => typeof v === "string" && v.trim()) ?? "";
function delta(a: Agent, id: string, text: string) {
  const m = a.messages.find((m) => m.id === id);
  if (m) m.text = (m.text + text).slice(-250000);
  else push(a, "assistant", text, id);
}
export function applyCodexEvent(a: Agent, method: string, p: any) {
  a.updatedAt = Date.now();
  if (method === "thread/status/changed") {
    a.state = p.status?.type === "active"
      ? p.status.activeFlags?.length ? "waiting" : "running"
      : p.status?.type === "idle" ? "idle" : "stopped";
  }
  if (method === "thread/settings/updated") {
    if (p.settings?.model) a.model = p.settings.model;
    if (p.settings?.effort) a.effort = p.settings.effort;
  }
  if (method === "turn/started") {
    a.state = "running";
    delete a.ask;
    a.turnId = p.turn?.id;
  }
  if (method === "item/agentMessage/delta") delta(a, p.itemId, p.delta ?? "");
  if (method === "item/started" || method === "item/completed") {
    const i = p.item;
    if (
      i?.type === "agentMessage" &&
      method === "item/completed" &&
      !a.messages.some((m) => m.id === i.id)
    )
      push(a, "assistant", i.text, i.id);
    if (i?.type === "commandExecution") {
      pushTool(
        a,
        i.id,
        "Shell",
        i.source === "userShell"
          ? "! " + (i.commandActions?.[0]?.command ?? i.command)
          : (i.command ?? "Running command"),
        i.command ?? "",
      );
      if (method === "item/completed")
        toolOutput(
          a,
          i.id,
          i.aggregatedOutput ?? "",
          i.exitCode != null && i.exitCode !== 0,
        );
    }
    if (i?.type === "fileChange") {
      const changes: any[] = i.changes ?? [];
      pushTool(
        a,
        i.id,
        "Edit files",
        changes.map((c) => c.path).join(", ") || "File changes",
        changes.map((c) => `${c.path}\n${c.diff ?? ""}`).join("\n"),
      );
      if (method === "item/completed")
        toolOutput(
          a,
          i.id,
          i.status ?? "",
          i.status === "failed" || i.status === "declined",
        );
    }
    if (i?.type === "mcpToolCall") {
      pushTool(a, i.id, `${i.server}.${i.tool}`, i.tool, i.arguments);
      if (method === "item/completed")
        toolOutput(
          a,
          i.id,
          i.error?.message ??
            JSON.stringify(i.result?.content ?? i.result ?? ""),
          !!i.error,
        );
    }
    if (i?.type === "collabAgentToolCall")
      for (const id of i.receiverThreadIds ?? []) {
        const state = i.agentsStates?.[id]?.status ?? "running",
          old = a.children.find((c) => c.id === id);
        if (old) {
          old.state = state;
          old.updatedAt = Date.now();
        } else
          a.children.push({
            id,
            task: i.prompt ?? i.tool ?? "Subagent",
            state,
            model: i.model,
            updatedAt: Date.now(),
          });
      }
  }
  if (method === "turn/completed") {
    a.pending = undefined;
    a.state =
      p.turn?.status === "failed"
        ? "failed"
        : p.turn?.status === "interrupted"
          ? "stopped"
          : "idle";
    if (p.turn?.error) a.error = p.turn.error.message;
    if (a.state === "idle") setAsk(a);
  }
  if (method === "error") {
    a.error = p.error?.message ?? p.message ?? "Agent error";
    if (!p.willRetry) a.state = "failed";
  }
}
/** Claude's `rate_limit_event`, in the shape its statusline reports limits. */
export function claudeRateLimits(info: any) {
  const out: Record<string, { used_percentage: number; resets_at: number }> = {};
  for (const k of ["five_hour", "seven_day"]) {
    const w = info?.unifiedWindows?.[k];
    if (typeof w?.utilization === "number" && typeof w.resetsAt === "number")
      out[k] = { used_percentage: Math.round(w.utilization * 100), resets_at: w.resetsAt };
  }
  return Object.keys(out).length ? out : undefined;
}
export function applyClaudeEvent(a: Agent, p: any) {
  a.updatedAt = Date.now();
  if (p.session_id) a.sid = p.session_id;
  if (p.type === "system" && p.subtype === "init") {
    a.model = p.model;
    a.state = "running";
  }
  // Claude reports its mode at start and after each change, also when it leaves auto by itself.
  if (p.type === "system" && typeof p.permissionMode === "string")
    a.permissionMode = p.permissionMode === "auto" ? "auto" : "manual";
  if (p.type === "stream_event") {
    const e = p.event;
    if (e?.type === "message_start")
      (a as any).streamId = e.message?.id ?? randomUUID();
    if (e?.type === "content_block_delta" && e.delta?.type === "text_delta")
      delta(a, (a as any).streamId ?? "stream", e.delta.text);
  }
  if (p.type === "assistant") {
    const m = p.message,
      id = m?.id ?? (a as any).streamId ?? "stream";
    const messageText = (m?.content ?? [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    if (messageText) {
      const streamed = a.messages.find(
        (x) => x.id === id || x.id === ((a as any).streamId ?? "stream"),
      );
      if (streamed) {
        streamed.id = id;
        streamed.text = messageText;
      } else push(a, "assistant", messageText, id);
    }
    for (const c of m?.content ?? []) {
      if (c.type === "tool_use")
        pushTool(a, c.id, c.name, toolSummary(c.input), c.input);
    }
  }
  if (p.type === "user")
    for (const c of p.message?.content ?? [])
      if (c?.type === "tool_result")
        toolOutput(
          a,
          c.tool_use_id,
          typeof c.content === "string"
            ? c.content
            : (c.content ?? []).map((b: any) => b.text ?? "").join("\n"),
          !!c.is_error,
        );
  if (p.type === "system" && p.subtype === "task_started")
    a.children.push({
      id: p.task_id,
      task: p.description ?? "Subagent",
      state: "running",
      updatedAt: Date.now(),
    });
  if (p.type === "system" && p.subtype === "task_notification") {
    const child = a.children.find((c) => c.id === p.task_id);
    if (child) {
      child.state = p.status;
      child.updatedAt = Date.now();
    }
  }
  if (p.type === "result") {
    if (typeof p.total_cost_usd === "number")
      a.estimatedCostUsd = p.total_cost_usd;
    a.pending = undefined;
    a.state = p.is_error ? "failed" : "idle";
    if (p.is_error) a.error = p.result ?? p.errors?.join("\n") ?? p.subtype;
    if (
      p.result &&
      !a.messages.some((m) => m.role === "assistant" && m.text === p.result)
    )
      push(a, "assistant", p.result);
    delete (a as any).streamId;
    if (a.state === "idle") setAsk(a);
  }
}

export class AgentWorkspace {
  private agents: Agent[] = [];
  private listeners = new Set<() => void>();
  private codex?: CodexRPC;
  private joined = new Set<string>();
  private joining = new Map<string, Promise<void>>();
  private codexRequests = new Map<string, NonNullable<Agent["pending"]>[]>();
  private claude = new Map<string, ChildProcessWithoutNullStreams>();
  private logins = new Map<
    string,
    { child: ChildProcessWithoutNullStreams; output: string; state: string }
  >();
  private booting = new Set<string>();
  /** `!` output that Claude reads with the next message, as in its terminal.
   *  Kept in the order the commands were typed; text is set when one ends. */
  private shellContext = new Map<string, { text?: string }[]>();
  private shells = new Set<ChildProcessWithoutNullStreams>();
  /** Codex agents whose next turn carries a changed approval policy. */
  private codexModes = new Set<string>();
  /** /model and /effort picks for a Codex agent's next turn; Codex keeps them after. */
  private codexPicks = new Map<string, { model?: string; effort?: string }>();
  /** Control requests in flight, by request id: what each one does. */
  private controlRequests = new Map<string, string>();
  private saved?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private closed = false;
  constructor(
    readonly profiles: Profile[],
    readonly dataDir = monitorDir(),
  ) {
    try {
      this.agents = JSON.parse(
        readFileSync(join(dataDir, "workspace.json"), "utf8"),
      );
      for (const a of this.agents) {
        a.state = "stopped";
        a.pending = undefined;
        a.queue = [];
      }
    } catch {}
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private emit() {
    if (this.closed) return;
    this.dirty = true;
    for (const fn of this.listeners) fn();
    if (!this.saved)
      this.saved = setTimeout(() => {
        this.saved = undefined;
        this.persist();
      }, 500);
  }
  private persist() {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const path = join(this.dataDir, "workspace.json");
    writeFileSync(path + ".tmp", JSON.stringify(this.agents), { mode: 0o600 });
    renameSync(path + ".tmp", path);
  }
  snapshot() {
    return {
      agents: this.agents,
      logins: [...this.logins].map(([profile, l]) => ({
        profile,
        output: l.output,
        state: l.state,
      })),
    };
  }
  private rpc() {
    if (!this.codex)
      this.codex = new CodexRPC((m, p, id) => {
        if (this.closed) return;
        if (m === "connection/closed") {
          this.joined.clear();
          this.joining.clear();
          this.codexRequests.clear();
          for (const a of this.agents.filter(
            (a) =>
              a.profile === "codex" && ["running", "waiting"].includes(a.state),
          )) {
            a.state = "failed";
            a.error = p.message;
            a.pending = undefined;
          }
          this.codex = undefined;
          this.emit();
          return;
        }
        const a = this.agents.find(
          (a) => a.sid === (p.threadId ?? p.thread?.id),
        );
        if (!a) return;
        if (id != null) {
          if (m === "mcpServer/elicitation/request" && p.requestedSchema)
            p.formFields = formFields(p.requestedSchema);
          const requests = this.codexRequests.get(a.id) || [];
          if (!requests.some(r => r.id === id)) requests.push({ id, method: m, params: p });
          this.codexRequests.set(a.id, requests);
          a.pending = requests[0];
          a.state = "waiting";
        } else if (m === "serverRequest/resolved") {
          this.resolveCodexRequest(a, p.requestId);
        } else {
          applyCodexEvent(a, m, p);
          if (m === "turn/completed") {
            this.codexRequests.delete(a.id);
            void this.next(a);
          }
        }
        this.emit();
      });
    return this.codex;
  }
  private resolveCodexRequest(a: Agent, id: any) {
    const requests = (this.codexRequests.get(a.id) || []).filter(r => r.id !== id);
    this.codexRequests.set(a.id, requests);
    a.pending = requests[0];
    if (!a.pending && a.state === "waiting") a.state = "running";
  }
  private async joinCodex(a: Agent) {
    if (!a.sid || this.joined.has(a.id)) return;
    const pending = this.joining.get(a.id);
    if (pending) return pending;
    const work = (async () => {
      const rpc = this.rpc();
      await rpc.ready;
      // Omitted settings preserve the running session's permissions and model.
      const r = await rpc.call("thread/resume", { threadId: a.sid, excludeTurns: true });
      a.model = r.model;
      a.effort = r.reasoningEffort;
      if (!this.codexModes.has(a.id)) a.permissionMode = codexMode(r.approvalPolicy);
      if (r.thread.recencyAt || r.thread.updatedAt)
        a.updatedAt = (r.thread.recencyAt || r.thread.updatedAt) * 1000;
      const status = r.thread.status;
      a.state = a.pending ? "waiting" : status?.type === "active"
        ? status.activeFlags?.length ? "waiting" : "running" : "idle";
      a.turnId = r.thread.turns?.find((t: any) => t.status === "inProgress")?.id;
      if (status?.type === "active" && !a.turnId) {
        const turns = await rpc.call("thread/turns/list", { threadId: a.sid, limit: 1, sortDirection: "desc", itemsView: "none" });
        a.turnId = turns.data?.find((t: any) => t.status === "inProgress")?.id;
      }
      a.error = undefined;
      this.joined.add(a.id);
      this.emit();
    })();
    this.joining.set(a.id, work);
    try { await work; } finally { this.joining.delete(a.id); }
  }
  async attach(profile: string, cwd: string, sid: string, history: string,
    title = "Codex session", updatedAt = Date.now(), startedAt = Date.now()) {
    if (this.profile(profile).source !== "codex") throw new Error("Only Codex uses shared sessions");
    let a = this.agents.find(a => a.profile === profile && a.sid === sid);
    const added = !a;
    if (!a) {
      a = newAgent(profile, cwd, title);
      a.updatedAt = updatedAt;
      a.startedAt = startedAt;
      a.sid = sid;
      a.history = history;
      a.external = true;
      this.agents.unshift(a);
    }
    try { await this.joinCodex(a); }
    catch (error) {
      if (added) this.agents = this.agents.filter(x => x !== a);
      throw error;
    }
    return a;
  }
  private profile(id: string) {
    const profile = this.profiles.find((p) => p.id === id);
    if (!profile) throw new Error("Unknown profile");
    return profile;
  }
  private env(profile: string) {
    const env = { ...process.env };
    delete env["CLAUDECODE"];
    delete env["CLAUDE_CODE_ENTRYPOINT"];
    delete env["ANTHROPIC_API_KEY"];
    delete env["ANTHROPIC_AUTH_TOKEN"];
    const p = this.profile(profile);
    if (p.source === "claude") {
      const dir = dirname(p.path);
      if (dir === join(homedir(), ".claude")) delete env["CLAUDE_CONFIG_DIR"];
      else env["CLAUDE_CONFIG_DIR"] = dir;
    }
    return env;
  }
  /** Commands are discovered separately for each tool and project. */
  async commands(profile: string, cwd: string) {
    const p = this.profile(profile);
    if (p.source === "claude") return claudeCommands(this.env(profile), dirname(p.path), cwd);
    const rpc = this.rpc();
    await rpc.ready;
    return codexCommands(rpc, cwd);
  }
  async accounts() {
    return Promise.all(
      this.profiles.map(async (p) => {
        try {
          if (p.source === "codex") {
            const rpc = this.rpc();
            await rpc.ready;
            const r = await rpc.call("account/read", { refreshToken: false });
            return {
              profile: p.id,
              connected: !!r.account,
              kind: r.account?.type,
              plan: r.account?.planType,
            };
          }
          const result = await new Promise<any>((resolve, reject) => {
            const c = spawn(
              process.env["CFIND_CLAUDE_BIN"] ?? "claude",
              ["auth", "status", "--json"],
              { env: this.env(p.id) },
            );
            let out = "";
            const timer = setTimeout(() => {
              c.kill();
              reject(new Error("Account check timed out"));
            }, 10000);
            c.stdout.on("data", (d) => (out += d));
            c.stderr.on("data", () => {});
            c.on("error", (e) => {
              clearTimeout(timer);
              reject(e);
            });
            c.on("close", () => {
              clearTimeout(timer);
              try {
                resolve(JSON.parse(out));
              } catch {
                resolve({ loggedIn: false });
              }
            });
          });
          return {
            profile: p.id,
            connected: result.loggedIn ?? result.authenticated ?? false,
            kind: result.authMethod,
            plan: result.subscriptionType,
          };
        } catch (e) {
          return {
            profile: p.id,
            connected: false,
            error: (e as Error).message,
          };
        }
      }),
    );
  }
  async login(profile: string) {
    const p = this.profile(profile);
    if (p.source === "codex") {
      const rpc = this.rpc();
      await rpc.ready;
      return rpc.call("account/login/start", { type: "chatgpt" });
    }
    const existing = this.logins.get(profile);
    if (existing?.state === "running") return { state: "running" };
    const child = spawn(
      process.env["CFIND_CLAUDE_BIN"] ?? "claude",
      ["auth", "login", "--claudeai"],
      { env: this.env(profile) },
    );
    const login = { child, output: "", state: "running" };
    this.logins.set(profile, login);
    const output = (d: Buffer) => {
      login.output = (login.output + d.toString()).slice(-12000);
      this.emit();
    };
    child.stdout.on("data", output);
    child.stderr.on("data", output);
    child.on("error", (e) => {
      login.output = e.message;
      login.state = "failed";
      this.emit();
    });
    child.on("close", (code) => {
      login.state = code === 0 ? "complete" : "failed";
      this.emit();
    });
    this.emit();
    return { state: "running" };
  }
  loginInput(profile: string, input: string) {
    const l = this.logins.get(profile);
    if (!l || l.state !== "running") throw new Error("No active sign-in");
    l.child.stdin.write(input + "\n");
  }
  async create(
    profile: string,
    cwd: string,
    prompt: string,
    sid?: string,
    history?: string,
    images: string[] = [],
  ) {
    this.profile(profile);
    const folder = resolve(cwd);
    if (!statSync(folder).isDirectory())
      throw new Error("Project folder is not a directory");
    if (
      this.agents.filter((a) =>
        ["running", "queued", "waiting"].includes(a.state),
      ).length >= 12
    )
      throw new Error("Twelve agents are already active");
    if (sid && this.agents.some((a) => a.sid === sid && a.profile === profile))
      throw new Error("This session is already in the workspace");
    const a = newAgent(profile, folder, prompt);
    a.sid = sid;
    if (sid) a.permissionMode = "manual";
    a.history = history;
    a.queue.push({ text: prompt, images });
    this.agents.unshift(a);
    this.emit();
    void this.next(a);
    return a;
  }
  async send(id: string, prompt: string, images: string[] = []) {
    const a = this.get(id);
    if (prompt.trim().startsWith("!")) {
      if (images.length) throw new Error("Send commands without image attachments");
      return this.shell(a, prompt.trim().slice(1).trim());
    }
    let queued: QueueItem = { text: prompt, images };
    if (this.profile(a.profile).source === "codex" && prompt.trim().startsWith("/")) {
      if (images.length) throw new Error("Send commands without image attachments");
      const item = await this.codexCommand(a, prompt.trim());
      if (!item) return a;
      queued = item;
    }
    const model = /^\/model\s+(\S+)$/.exec(prompt.trim())?.[1];
    if (model && !images.length && this.profile(a.profile).source !== "codex") {
      this.setModel(a, model);
      return a;
    }
    if (a.queue.length >= 20) throw new Error("Agent queue is full");
    a.updatedAt = Date.now();
    a.queue.push(queued);
    if (!["running", "waiting"].includes(a.state)) void this.next(a);
    this.emit();
    return a;
  }
  private async codexCommand(a: Agent, prompt: string): Promise<QueueItem | undefined> {
    const [, name = "", argument = ""] = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(prompt) || [];
    const commands = await this.commands(a.profile, a.cwd);
    const command = commands.find(c => c.name === name);
    if (!command) throw new Error(`Unsupported Codex command /${name}. Use / to see available commands.`);
    if (command.skillPath) return { text: argument.trim(), skill: { name, path: command.skillPath } };
    if (!a.sid) throw new Error("Codex is still starting. Try this command again.");
    await this.joinCodex(a);
    const rpc = this.rpc(), arg = argument.trim();
    if (name === "model" || name === "effort") {
      if (!arg) {
        push(a, "note", commands.filter(c => c.name.startsWith(name + " ")).map(c => "/" + c.name).join("\n"));
      } else {
        if (!commands.some(c => c.name === `${name} ${arg}`)) throw new Error(`Unknown ${name}: ${arg}`);
        this.codexPicks.set(a.id, { ...this.codexPicks.get(a.id), [name]: arg });
        if (name === "model") a.model = arg;
        else a.effort = arg;
        push(a, "note", `${name === "model" ? "Model" : "Reasoning effort"} set to ${arg}. It starts with the next message.`);
      }
    } else if (name === "compact") {
      await rpc.call("thread/compact/start", { threadId: a.sid });
      push(a, "note", "Compacting this conversation");
    } else if (name === "rename") {
      if (!arg) throw new Error("Use /rename followed by the conversation title");
      await rpc.call("thread/name/set", { threadId: a.sid, name: arg });
      a.title = arg.slice(0, 100);
    } else if (name === "stop") {
      await this.cancel(a.id);
    } else if (name === "status") {
      push(a, "note", `Model: ${a.model || "Default"}\nReasoning: ${a.effort || "Default"}\nState: ${a.state}\nProject: ${a.cwd}`);
    } else if (name === "skills") {
      push(a, "note", commands.filter(c => c.skillPath).map(c => `/${c.name} — ${c.description || ""}`).join("\n") || "No skills available in this project");
    }
    a.updatedAt = Date.now();
    this.emit();
  }
  /** Claude's control request changes this agent only. Typed in a terminal,
   *  /model would also save it as the default for new sessions. */
  private setModel(a: Agent, model: string) {
    a.pickedModel = model === "default" ? undefined : model;
    const child = this.claude.get(a.id);
    if (child)
      child.stdin.write(
        JSON.stringify({
          type: "control_request",
          request_id: randomUUID(),
          request: {
            subtype: "set_model",
            ...(a.pickedModel ? { model: a.pickedModel } : {}),
          },
        }) + "\n",
      );
    else push(a, "note", `Uses ${model} from the next message`);
    this.emit();
  }
  /** Moves a Claude agent to an interactive `claude --resume` in tmux, so the
   *  chat can use its terminal. Only between replies. */
  async openInTerminal(id: string) {
    const a = this.get(id);
    if (this.profile(a.profile).source !== "claude")
      throw new Error("Only Claude agents open in a terminal");
    if (
      ["running", "waiting", "queued"].includes(a.state) ||
      this.booting.has(a.id)
    )
      throw new Error("Wait for the reply to finish");
    if (!a.sid) throw new Error("This agent has no session yet");
    const child = this.claude.get(a.id);
    if (child) {
      // Removed first, so its exit is not shown as a failure. Two processes must
      // not write one transcript, so the terminal starts after this one ends.
      this.claude.delete(a.id);
      const gone = new Promise((r) => {
        child.once("close", r);
        setTimeout(r, 5000).unref();
      });
      child.kill("SIGTERM");
      const hard = setTimeout(() => child.kill("SIGKILL"), 3000);
      await gone;
      clearTimeout(hard);
    }
    const dir = this.env(a.profile)["CLAUDE_CONFIG_DIR"],
      started = startInTmux(a.cwd, [
        "env",
        ...[
          "CLAUDECODE",
          "CLAUDE_CODE_ENTRYPOINT",
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          ...(dir ? [] : ["CLAUDE_CONFIG_DIR"]),
        ].flatMap((k) => ["-u", k]),
        ...(dir ? [`CLAUDE_CONFIG_DIR=${dir}`] : []),
        claudeBin(),
        "--resume",
        a.sid,
        "--permission-mode",
        a.permissionMode ?? "manual",
        ...(a.pickedModel ? ["--model", a.pickedModel] : []),
      ]);
    this.shellContext.delete(a.id);
    this.agents = this.agents.filter((x) => x !== a);
    this.emit();
    return { profile: a.profile, sid: a.sid, ...started };
  }
  /** Auto runs commands without asking; manual asks before each one. */
  setMode(id: string, mode: string) {
    const a = this.get(id);
    if (mode !== "auto" && mode !== "manual") throw new Error("Unknown mode");
    const child = this.claude.get(a.id);
    if (this.profile(a.profile).source === "codex") {
      a.permissionMode = mode;
      this.codexModes.add(a.id);
      if (["running", "waiting"].includes(a.state))
        push(a, "note", "The new mode starts with the next message");
    } else if (child) {
      // Claude confirms with a status event, which sets permissionMode.
      const request_id = randomUUID();
      this.controlRequests.set(request_id, "change the mode");
      child.stdin.write(
        JSON.stringify({
          type: "control_request",
          request_id,
          request: {
            subtype: "set_permission_mode",
            mode: mode === "auto" ? "auto" : "default",
          },
        }) + "\n",
      );
    } else a.permissionMode = mode;
    this.emit();
    return a;
  }
  /** `! command` in the agent's folder. Codex records it in its thread; Claude
   *  gets the output with the next message, the way its terminal does it. */
  private async shell(a: Agent, command: string) {
    if (!command) throw new Error("Type a command after !");
    if (this.profile(a.profile).source === "codex") {
      if (!a.sid) throw new Error("Codex is still starting. Try this command again.");
      await this.joinCodex(a);
      await this.rpc().call("thread/shellCommand", {
        threadId: a.sid,
        command,
        timeoutMs: SHELL_MS,
      });
      return a;
    }
    const id = randomUUID();
    pushTool(a, id, "Shell", "! " + command, command);
    a.updatedAt = Date.now();
    this.emit();
    const child = spawn(process.env["SHELL"] || "/bin/zsh", ["-lc", command], {
      cwd: a.cwd,
      env: this.env(a.profile),
      // Its own process group, so a timeout also stops what the command started.
      detached: true,
    });
    child.stdin.end();
    this.shells.add(child);
    const entry: { text?: string } = {};
    this.shellContext.set(a.id, [...(this.shellContext.get(a.id) ?? []), entry]);
    let stdout = "",
      stderr = "",
      timedOut = false;
    const collect = (d: Buffer, old: string) =>
      old.length >= SHELL_OUTPUT ? old : (old + d.toString()).slice(0, SHELL_OUTPUT);
    child.stdout.on("data", (d) => (stdout = collect(d, stdout)));
    child.stderr.on("data", (d) => (stderr = collect(d, stderr)));
    const stop = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, SHELL_MS);
    const done = (code: number | null, error?: string) => {
      clearTimeout(timer);
      if (!this.shells.delete(child)) return;
      if (error) stderr += error;
      if (timedOut) stderr += "\nStopped after 2 minutes";
      toolOutput(
        a,
        id,
        [stdout, stderr].filter(Boolean).join("\n") || "(no output)",
        code !== 0,
      );
      entry.text =
        `<bash-input>${escapeTags(command)}</bash-input>\n` +
        (stdout || stderr
          ? `<bash-stdout>${escapeTags(stdout)}</bash-stdout><bash-stderr>${escapeTags(stderr)}</bash-stderr>`
          : "<bash-stdout>(Bash completed with no output)</bash-stdout><bash-stderr></bash-stderr>");
      a.updatedAt = Date.now();
      this.emit();
    };
    child.on("error", (e) => done(null, e.message));
    child.on("close", (code) => done(code));
    return a;
  }
  /** Stops the current reply, so the next queued message goes at once. */
  async sendNow(id: string) {
    const a = this.get(id);
    if (!a.queue.length) throw new Error("Nothing is waiting to be sent");
    if (this.profile(a.profile).source === "codex") {
      if (!a.sid || !a.turnId) throw new Error("No active Codex reply to stop");
      // turn/completed then sends the queue.
      await this.rpc().call("turn/interrupt", { threadId: a.sid, turnId: a.turnId });
      return a;
    }
    const child = this.claude.get(a.id);
    if (!child) throw new Error("No active Claude reply to stop");
    // Claude ends the turn with a result event, which sends the queue.
    const request_id = randomUUID();
    this.controlRequests.set(request_id, "stop the reply");
    child.stdin.write(
      JSON.stringify({
        type: "control_request",
        request_id,
        request: { subtype: "interrupt" },
      }) + "\n",
    );
    return a;
  }
  unqueue(id: string, index: number) {
    const a = this.get(id);
    if (!(index >= 0 && index < a.queue.length))
      throw new Error("Queued message not found");
    a.queue.splice(index, 1);
    this.emit();
    return a;
  }
  private get(id: string) {
    const a = this.agents.find((a) => a.id === id);
    if (!a) throw new Error("Unknown workspace agent");
    return a;
  }
  private async next(a: Agent) {
    if (
      this.booting.has(a.id) ||
      a.state === "running" ||
      a.state === "waiting" ||
      !a.queue.length
    )
      return;
    this.booting.add(a.id);
    a.state = "running";
    a.error = undefined;
    delete a.ask;
    const { text: prompt, images = [], skill } = a.queue.shift()!;
    push(a, "user", prompt, undefined, images.length ? images : undefined);
    this.emit();
    try {
      if (this.profile(a.profile).source === "codex") {
        const rpc = this.rpc();
        await rpc.ready;
        if (!a.sid) {
          const r = await rpc.call("thread/start", {
            cwd: a.cwd,
            approvalPolicy: codexPolicy(a),
            approvalsReviewer: "user",
            sandbox: "workspace-write",
          });
          a.sid = r.thread.id;
          a.model = r.model;
          this.codexModes.delete(a.id);
          this.joined.add(a.id);
        } else
          await this.joinCodex(a);
        a.state = "running";
        const r = await rpc.call("turn/start", {
          threadId: a.sid,
          input: [
            ...(skill ? [{ type: "skill", ...skill }] : []),
            ...(prompt.trim()
              ? [{ type: "text", text: prompt, text_elements: [] }]
              : []),
            ...images.map((id) => ({
              type: "localImage",
              path: uploadPath(id),
            })),
          ],
          // Codex keeps these for later turns, so each is sent once per change.
          ...(this.codexModes.has(a.id) ? { approvalPolicy: codexPolicy(a) } : {}),
          ...this.codexPicks.get(a.id),
        });
        this.codexModes.delete(a.id);
        this.codexPicks.delete(a.id);
        a.turnId = r.turn.id;
      } else {
        let child = this.claude.get(a.id);
        if (!child) {
          const args = [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--permission-mode",
            a.permissionMode ?? "manual",
            // Without a prompt tool, print mode denies every tool that needs approval.
            "--permission-prompt-tool",
            "stdio",
          ];
          if (a.sid) args.push("--resume", a.sid);
          if (a.pickedModel) args.push("--model", a.pickedModel);
          child = spawn(process.env["CFIND_CLAUDE_BIN"] ?? "claude", args, {
            cwd: a.cwd,
            env: this.env(a.profile),
          });
          this.claude.set(a.id, child);
          const agentProcess = child;
          let stderr = "";
          createInterface({ input: child.stdout }).on("line", (line) => {
            try {
              const p = JSON.parse(line);
              if (p.type === "control_request") {
                a.pending = {
                  id: p.request_id,
                  method: p.request.subtype,
                  params: p.request,
                };
                a.state = "waiting";
              } else if (p.type === "control_response") {
                const r = p.response,
                  what = this.controlRequests.get(r?.request_id);
                this.controlRequests.delete(r?.request_id);
                if (r?.subtype === "error")
                  push(
                    a,
                    "note",
                    `Could not ${what ?? "change the model"}: ${String(r.error).slice(0, 300)}`,
                  );
                else if (typeof r?.response?.model === "string") {
                  a.model = r.response.model;
                  push(a, "note", `Model set to ${a.model}`);
                }
              } else if (p.type === "control_cancel_request") {
                if (a.pending?.id === p.request_id) {
                  a.pending = undefined;
                  a.state = "running";
                }
              } else if (p.type === "rate_limit_event") {
                // Print mode runs no statusline, so this is its only report of the limits.
                const limits = claudeRateLimits(p.rate_limit_info);
                if (limits)
                  recordSignal(
                    a.profile,
                    { session_id: p.session_id ?? a.sid, rate_limits: limits },
                    this.dataDir,
                    "statusline",
                  );
              } else {
                applyClaudeEvent(a, p);
                if (p.type === "result") void this.next(a);
              }
              this.emit();
            } catch {}
          });
          child.stderr.on("data", (d) => {
            stderr = (stderr + d.toString()).slice(-4000);
          });
          const failed = (message: string) => {
            this.claude.delete(a.id);
            if (a.state === "running" || a.state === "waiting") {
              a.state = "failed";
              a.error = message;
            }
            this.emit();
          };
          child.on("error", (e) => failed(e.message));
          child.on("close", (code) => {
            if (this.claude.get(a.id) !== agentProcess) return;
            failed(stderr || `Claude exited (${code})`);
          });
        }
        // Commands still running go with a later message.
        const context = this.shellContext.get(a.id) ?? [],
          running = context.filter((c) => c.text === undefined);
        if (running.length) this.shellContext.set(a.id, running);
        else this.shellContext.delete(a.id);
        const text = [...context.map((c) => c.text), prompt.trim() ? prompt : ""]
          .filter(Boolean)
          .join("\n\n");
        child.stdin.write(
          JSON.stringify({
            type: "user",
            message: {
              role: "user",
              content: images.length
                ? [
                    ...images.map((id) => ({
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: uploadType(id),
                        data: readFileSync(uploadPath(id)).toString("base64"),
                      },
                    })),
                    ...(text ? [{ type: "text", text }] : []),
                  ]
                : text,
            },
            session_id: a.sid ?? "",
            parent_tool_use_id: null,
          }) + "\n",
        );
      }
    } catch (e) {
      a.state = "failed";
      a.error = (e as Error).message;
    } finally {
      this.booting.delete(a.id);
      this.emit();
    }
  }
  async respond(id: string, answer: any) {
    const a = this.get(id),
      p = a.pending;
    if (!p) throw new Error("No pending request");
    if (answer.requestId != null && String(answer.requestId) !== String(p.id))
      throw new Error("This request changed or expired. Answer the current request.");
    // answer.answers maps a question key to the chosen labels or typed text.
    const answers: Record<string, string[]> = answer.answers ?? {};
    if (this.profile(a.profile).source === "codex") {
      const decision = answer.decision ?? (!answer.allow ? "decline" : answer.always ? "acceptForSession" : "accept");
      if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(p.method)) {
        const allowed = p.params.availableDecisions || ["accept", "acceptForSession", "decline", "cancel"];
        if (!allowed.some((d: any) => JSON.stringify(d) === JSON.stringify(decision)))
          throw new Error("This approval option is no longer available");
      }
      const result =
        p.method === "item/tool/requestUserInput"
          ? {
              answers: Object.fromEntries(
                Object.entries(answers).map(([k, v]) => [k, { answers: v }]),
              ),
            }
          : p.method === "item/permissions/requestApproval"
            ? {
                permissions: answer.allow ? p.params.permissions : {},
                scope: answer.always ? "session" : "turn",
              }
            : p.method === "mcpServer/elicitation/request"
              ? {
                  action: answer.cancel ? "cancel" : answer.allow ? "accept" : "decline",
                  content: answer.allow && p.params.requestedSchema
                    ? formContent(p.params.requestedSchema, answer.content)
                    : null,
                }
              : {
                  decision,
                };
      this.rpc().respond(p.id, result);
      this.resolveCodexRequest(a, p.id);
    } else {
      const input = p.params.input ?? {},
        // Only session-scoped rules; saving rules to settings files stays in the terminal.
        session = (p.params.permission_suggestions ?? []).filter(
          (s: any) => s.destination === "session",
        );
      const response =
        p.method !== "can_use_tool"
          ? {}
          : !answer.allow
            ? {
                behavior: "deny",
                message: answer.message || "Declined in dashboard",
              }
            : p.params.tool_name === "AskUserQuestion"
              ? {
                  behavior: "allow",
                  updatedInput: {
                    ...input,
                    answers: Object.fromEntries(
                      Object.entries(answers).map(([k, v]) => [
                        k,
                        v.join(", "),
                      ]),
                    ),
                  },
                }
              : {
                  behavior: "allow",
                  updatedInput: input,
                  ...(answer.always && session.length
                    ? { updatedPermissions: session }
                    : {}),
                };
      this.claude.get(a.id)?.stdin.write(
        JSON.stringify({
          type: "control_response",
          response: { subtype: "success", request_id: p.id, response },
        }) + "\n",
      );
    }
    // Show the user's side of the exchange in the conversation.
    const asked: any[] = p.params.questions ?? p.params.input?.questions ?? [],
      said = Object.entries(answers).map(([k, v]) => [
        asked.find((q) => q.id === k || q.question === k)?.question ?? k,
        v.join(", "),
      ]);
    if (!answer.allow && answer.message) push(a, "user", answer.message);
    else if (answer.allow && said.length)
      push(
        a,
        "user",
        said.length === 1
          ? said[0]![1]!
          : said.map(([q, v]) => `${q}: ${v}`).join("\n"),
      );
    if (this.profile(a.profile).source !== "codex") a.pending = undefined;
    a.state = a.pending ? "waiting" : "running";
    a.updatedAt = Date.now();
    this.emit();
  }
  async cancel(id: string) {
    const a = this.get(id);
    a.queue = [];
    if (this.profile(a.profile).source === "codex") {
      if (!a.sid || !a.turnId) throw new Error("No active Codex reply to stop");
      const rpc = this.rpc();
      await rpc.ready;
      await rpc.call("turn/interrupt", { threadId: a.sid, turnId: a.turnId });
    } else {
      this.claude.get(id)?.kill("SIGTERM");
      this.claude.delete(id);
    }
    a.state = "stopped";
    a.pending = undefined;
    this.codexRequests.delete(a.id);
    a.updatedAt = Date.now();
    this.emit();
  }
  dismiss(id: string) {
    const a = this.get(id);
    if (["running", "waiting", "queued"].includes(a.state))
      throw new Error("Stop the agent before removing its card");
    this.claude.get(id)?.kill();
    this.claude.delete(id);
    this.agents = this.agents.filter((a) => a.id !== id);
    this.emit();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.saved) clearTimeout(this.saved);
    if (this.dirty) this.persist();
    this.codex?.close();
    for (const c of this.claude.values()) c.kill();
    for (const c of this.shells) {
      try {
        process.kill(-c.pid!, "SIGKILL");
      } catch {}
    }
    for (const l of this.logins.values()) l.child.kill();
  }
}
