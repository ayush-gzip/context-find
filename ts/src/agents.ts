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
import { claudeCommands } from "./commands.ts";
import { uploadPath, uploadType } from "./uploads.ts";

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
  state: string;
  startedAt: number;
  updatedAt: number;
  messages: Message[];
  queue: QueueItem[];
  children: Child[];
  error?: string;
  estimatedCostUsd?: number;
  pending?: { id: any; method: string; params: any };
}
export function newAgent(profile: string, cwd: string, title: string): Agent {
  return {
    id: randomUUID(),
    profile,
    cwd,
    title: title.slice(0, 100),
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
  if (method === "turn/started") {
    a.state = "running";
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
        i.command ?? "Running command",
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
  }
  if (method === "error") {
    a.error = p.error?.message ?? p.message ?? "Agent error";
    if (!p.willRetry) a.state = "failed";
  }
}
export function applyClaudeEvent(a: Agent, p: any) {
  a.updatedAt = Date.now();
  if (p.session_id) a.sid = p.session_id;
  if (p.type === "system" && p.subtype === "init") {
    a.model = p.model;
    a.state = "running";
  }
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
  }
}

class CodexRPC {
  child: ChildProcessWithoutNullStreams;
  private next = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  ready: Promise<any>;
  constructor(private event: (m: string, p: any, id?: any) => void) {
    this.child = spawn(
      process.env["CFIND_CODEX_BIN"] ?? "codex",
      ["app-server", "--listen", "stdio://"],
      { env: process.env },
    );
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        const m = JSON.parse(line);
        if (m.id != null && !m.method) {
          const p = this.pending.get(m.id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(m.id);
            m.error
              ? p.reject(new Error(m.error.message))
              : p.resolve(m.result);
          }
        } else if (m.method) this.event(m.method, m.params ?? {}, m.id);
      } catch {}
    });
    this.child.stderr.on("data", () => {});
    this.child.on("error", (e) => this.fail(e));
    this.child.on("exit", () =>
      this.fail(new Error("Codex connection closed")),
    );
    this.ready = this.call("initialize", {
      clientInfo: {
        name: "context_find",
        title: "Context Find",
        version: "0.2.0",
      },
      capabilities: { experimentalApi: true },
    }).then(() =>
      this.child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n"),
    );
    this.ready.catch(() => {});
  }
  private fail(e: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    this.event("connection/closed", { message: e.message });
  }
  call(method: string, params: any = {}): Promise<any> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        JSON.stringify({ id, method, params }) + "\n",
        (e) => {
          if (e) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(e);
          }
        },
      );
    });
  }
  respond(id: any, result: any) {
    this.child.stdin.write(JSON.stringify({ id, result }) + "\n");
  }
  close() {
    this.child.kill();
  }
}

export class AgentWorkspace {
  private agents: Agent[] = [];
  private listeners = new Set<() => void>();
  private codex?: CodexRPC;
  private claude = new Map<string, ChildProcessWithoutNullStreams>();
  private logins = new Map<
    string,
    { child: ChildProcessWithoutNullStreams; output: string; state: string }
  >();
  private booting = new Set<string>();
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
        if (m === "connection/closed") {
          for (const a of this.agents.filter(
            (a) =>
              a.profile === "codex" && ["running", "waiting"].includes(a.state),
          )) {
            a.state = "failed";
            a.error = p.message;
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
          a.pending = { id, method: m, params: p };
          a.state = "waiting";
        } else {
          applyCodexEvent(a, m, p);
          if (m === "turn/completed") void this.next(a);
        }
        this.emit();
      });
    return this.codex;
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
  /** The / menu for a profile. Codex gets none: its app server does not run them. */
  async commands(profile: string, cwd: string) {
    const p = this.profile(profile);
    return p.source === "claude"
      ? claudeCommands(this.env(profile), dirname(p.path), cwd)
      : [];
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
    a.history = history;
    a.queue.push({ text: prompt, images });
    this.agents.unshift(a);
    this.emit();
    void this.next(a);
    return a;
  }
  async send(id: string, prompt: string, images: string[] = []) {
    const a = this.get(id);
    if (a.queue.length >= 20) throw new Error("Agent queue is full");
    a.queue.push({ text: prompt, images });
    if (!["running", "waiting"].includes(a.state)) void this.next(a);
    this.emit();
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
    const { text: prompt, images = [] } = a.queue.shift()!;
    push(a, "user", prompt, undefined, images.length ? images : undefined);
    this.emit();
    try {
      if (this.profile(a.profile).source === "codex") {
        const rpc = this.rpc();
        await rpc.ready;
        if (!a.sid) {
          const r = await rpc.call("thread/start", {
            cwd: a.cwd,
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandbox: "workspace-write",
          });
          a.sid = r.thread.id;
          a.model = r.model;
        } else
          await rpc.call("thread/resume", {
            threadId: a.sid,
            cwd: a.cwd,
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandbox: "workspace-write",
          });
        const r = await rpc.call("turn/start", {
          threadId: a.sid,
          input: [
            ...(prompt.trim()
              ? [{ type: "text", text: prompt, text_elements: [] }]
              : []),
            ...images.map((id) => ({
              type: "localImage",
              path: uploadPath(id),
            })),
          ],
        });
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
            "manual",
            // Without a prompt tool, print mode denies every tool that needs approval.
            "--permission-prompt-tool",
            "stdio",
          ];
          if (a.sid) args.push("--resume", a.sid);
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
              } else if (p.type === "control_cancel_request") {
                if (a.pending?.id === p.request_id) {
                  a.pending = undefined;
                  a.state = "running";
                }
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
                    ...(prompt.trim() ? [{ type: "text", text: prompt }] : []),
                  ]
                : prompt,
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
    // answer.answers maps a question key to the chosen labels or typed text.
    const answers: Record<string, string[]> = answer.answers ?? {};
    if (this.profile(a.profile).source === "codex") {
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
                scope: "turn",
              }
            : p.method === "mcpServer/elicitation/request"
              ? {
                  action: answer.allow ? "accept" : "decline",
                  content: answer.content ?? null,
                }
              : {
                  decision: !answer.allow
                    ? "decline"
                    : answer.always
                      ? "acceptForSession"
                      : "accept",
                };
      this.rpc().respond(p.id, result);
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
    a.pending = undefined;
    a.state = "running";
    this.emit();
  }
  async cancel(id: string) {
    const a = this.get(id);
    a.queue = [];
    if (a.profile === "codex" && a.sid && a.turnId) {
      const rpc = this.rpc();
      await rpc.ready;
      await rpc.call("turn/interrupt", { threadId: a.sid, turnId: a.turnId });
    } else {
      this.claude.get(id)?.kill("SIGTERM");
      this.claude.delete(id);
    }
    a.state = "stopped";
    a.pending = undefined;
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
    for (const l of this.logins.values()) l.child.kill();
  }
}
