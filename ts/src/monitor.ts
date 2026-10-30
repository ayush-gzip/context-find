import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { codexRoots, projectsRoots } from "./store.ts";
import { stripPasteTags } from "./conversation.ts";
import { askCommand, askReply, askScript } from "./asks.ts";

export interface Profile {
  id: string;
  label: string;
  source: "claude" | "codex";
  path: string;
}
export interface Tokens {
  input: number;
  output: number;
  cached: number;
  created: number;
  reasoning: number;
}
export interface Usage extends Tokens {}
export interface Bucket {
  day: string;
  model: string;
  tokens: Tokens;
}
export interface Quota {
  used: number;
  resetsAt: number;
  minutes?: number;
}
export interface Limits {
  session?: Quota;
  week?: Quota;
  plan?: string;
  observedAt: number;
}
export interface ObservedSession {
  id: string;
  profile: string;
  source: string;
  path: string;
  cwd: string;
  title: string;
  model: string;
  parent: string | null;
  updatedAt: number;
  startedAt: number;
  /** When you or the agent last wrote a message. Tool runs and other file
   *  writes move `updatedAt` but not this; the Agents board sorts by it. */
  lastActive?: number;
  state: string;
  /** A live process (another window) owns this session. */
  open?: boolean;
  /** That process runs in a tmux pane, so input can be typed into it. */
  tmux?: boolean;
  /** The turn ended, but a command it started in the background still runs. */
  shell?: boolean;
  tokens: Tokens;
  usageAvailable: boolean;
  /** The turn ended and the agent waits for the user's answer to this. */
  ask?: string;
}
export interface LiveRecord {
  profile: string;
  sessionId: string;
  pid: number;
  procStart: string;
  /** tmux pane id such as %12, or "" outside tmux. */
  tmux: string;
  status: string;
  updatedAt: number;
}
interface Copies {
  tokens: Tokens;
  buckets: Record<string, Tokens>;
}
interface FileState {
  size: number;
  mtime: number;
  ino: number;
  session: ObservedSession;
  buckets: Record<string, Bucket>;
  seen: Record<string, Tokens>;
  /** Bucket key ("day|model") where each Claude message ID was first counted. */
  slot: Record<string, string>;
  cumulative: Tokens;
  limits?: Limits;
  /** Since the user's last message: the question from a `cfind ask` call, and
   *  the end of the latest reply. */
  ask?: string;
  reply?: string;
}
export const zero = (): Tokens => ({
  input: 0,
  output: 0,
  cached: 0,
  created: 0,
  reasoning: 0,
});
const count = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0;
export function add(to: Tokens, value: Tokens) {
  for (const key of Object.keys(to) as (keyof Tokens)[]) to[key] += value[key];
  return to;
}
const minus = (from: Tokens, value: Tokens) => {
  const out = { ...from };
  for (const key of Object.keys(out) as (keyof Tokens)[])
    out[key] = Math.max(0, out[key] - value[key]);
  return out;
};
const object = (v: any): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const at = (v: any, fallback: number) => {
  const n = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(n) ? n : fallback;
};
const text = (content: any) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((x) => x?.type === "text" || x?.type === "input_text")
          .map((x) => x.text || "")
          .join(" ")
      : "";
export const monitorDir = () =>
  process.env["CFIND_DATA_DIR"] ||
  join(homedir(), ".context-find", "dashboard");

export function dashboardProfiles(): Profile[] {
  const personal = join(homedir(), ".claude-personal", "projects");
  const paths = [
    ...projectsRoots(),
    ...(existsSync(personal) ? [personal] : []),
  ];
  const unique = new Set<string>();
  const profiles: Profile[] = [];
  for (const path of paths) {
    const canonical = realpathSync(path);
    if (unique.has(canonical)) continue;
    unique.add(canonical);
    const name = basename(dirname(path));
    profiles.push({
      id:
        name === ".claude"
          ? "claude"
          : name === ".claude-personal"
            ? "personal"
            : `claude:${resolve(path)}`,
      label:
        name === ".claude"
          ? "Claude · Default"
          : name === ".claude-personal"
            ? "Claude · Personal"
            : `Claude · ${name}`,
      source: "claude",
      path: canonical,
    });
  }
  for (const path of codexRoots())
    profiles.push({
      id: "codex",
      label: "Codex",
      source: "codex",
      path: realpathSync(path),
    });
  return profiles;
}

const isTranscript = (path: string) =>
  path.endsWith(".jsonl") && !basename(path).startsWith("observer-");
function filesUnder(root: string, files: string[] = []): string[] {
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const path = join(root, e.name);
      if (e.isDirectory()) filesUnder(path, files);
      else if (isTranscript(path)) files.push(path);
    }
  } catch {
    /* a missing store is not a collection failure */
  }
  return files;
}
function quota(v: any): Quota | undefined {
  if (!object(v)) return;
  const used = v.used_percentage ?? v.used_percent ?? v.usedPercent;
  const reset = v.resets_at ?? v.resetsAt;
  if (typeof used !== "number" || typeof reset !== "number") return;
  return {
    used: Math.max(0, Math.min(100, used)),
    resetsAt: reset,
    minutes: v.window_minutes ?? v.windowDurationMins,
  };
}
export function parseLimits(value: any, time = Date.now()): Limits | undefined {
  if (!object(value)) return;
  const session = quota(value.five_hour ?? value.primary),
    week = quota(value.seven_day ?? value.secondary);
  if (!session && !week) return;
  return {
    session,
    week,
    plan: value.plan_type ?? value.planType,
    observedAt: time,
  };
}

function freshFile(
  profile: Profile,
  path: string,
  mtime: number,
  ino: number,
): FileState {
  const isChild = path.includes("/subagents/");
  return {
    size: 0,
    mtime: 0,
    ino,
    buckets: {},
    seen: {},
    slot: {},
    cumulative: zero(),
    session: {
      id: basename(path, ".jsonl"),
      profile: profile.id,
      source: profile.source,
      path,
      cwd: "",
      title: "Untitled session",
      model: "Unknown",
      parent: isChild ? basename(dirname(dirname(path))) : null,
      updatedAt: mtime,
      startedAt: mtime,
      state: "unknown",
      tokens: zero(),
      usageAvailable: false,
    },
  };
}
// Enough of the reply for its last paragraph; this is kept in the cache.
const REPLY = 600;
function watchAsk(f: FileState, row: any) {
  if (row.isSidechain) return;
  const content = row.message?.content,
    p = row.payload;
  // Claude: the user's own message starts over; tool results are not one.
  if (
    row.type === "user" &&
    !row.isMeta &&
    (typeof content === "string" ||
      (Array.isArray(content) && content.some((c) => c?.type === "text")))
  )
    f.ask = f.reply = undefined;
  if (row.type === "assistant" && Array.isArray(content))
    for (const c of content) {
      if (c?.type === "text" && c.text?.trim()) f.reply = c.text.slice(-REPLY);
      if (c?.type === "tool_use" && typeof c.input?.command === "string")
        f.ask = askCommand(c.input.command) ?? f.ask;
    }
  // Codex: each turn starts with task_started.
  if (row.type === "event_msg" && p?.type === "task_started")
    f.ask = f.reply = undefined;
  if (row.type !== "response_item") return;
  if (p?.type === "message" && p.role === "assistant" && Array.isArray(p.content)) {
    const t = p.content
      .filter((c: any) => c?.type === "output_text")
      .map((c: any) => c.text ?? "")
      .join("\n");
    if (t.trim()) f.reply = t.slice(-REPLY);
  }
  if (p?.type === "custom_tool_call" && typeof p.input === "string")
    f.ask = askScript(p.input) ?? f.ask;
  if (p?.type === "function_call" && typeof p.arguments === "string")
    try {
      const a = JSON.parse(p.arguments),
        cmd = a.cmd ?? a.command;
      f.ask = askCommand(Array.isArray(cmd) ? cmd.join(" ") : String(cmd ?? "")) ?? f.ask;
    } catch {}
}
function consume(f: FileState, row: any, mtime: number) {
  if (!object(row)) return;
  const s = f.session,
    time = at(row.timestamp, mtime);
  s.startedAt = Math.min(s.startedAt, time);
  s.updatedAt = Math.max(s.updatedAt, time);
  if (typeof row.cwd === "string") s.cwd = row.cwd;
  if (typeof row.sessionId === "string" && !s.parent) s.id = row.sessionId;
  if (row.type === "session_meta" && object(row.payload)) {
    s.id = row.payload.id ?? row.payload.session_id ?? s.id;
    s.cwd = row.payload.cwd ?? s.cwd;
    const parent = row.payload.source?.subagent?.thread_spawn?.parent_thread_id;
    if (typeof parent === "string") s.parent = parent;
  }
  if (row.type === "turn_context" && typeof row.payload?.model === "string")
    s.model = row.payload.model;
  if (
    row.type === "user" ||
    (row.type === "response_item" && row.payload?.role === "user")
  ) {
    const t = text(row.message?.content ?? row.payload?.content);
    if (
      t &&
      !t.startsWith("# AGENTS.md") &&
      !t.startsWith("<") &&
      !t.startsWith("[Request interrupted")
    ) {
      if (!row.isMeta && !row.isSidechain)
        s.lastActive = Math.max(s.lastActive ?? 0, time);
      if (s.title === "Untitled session") s.title = t.slice(0, 220);
    }
  }
  const said = (content: any, type: string) =>
    Array.isArray(content) &&
    content.some((c: any) => c?.type === type && c.text?.trim());
  if (
    (row.type === "assistant" &&
      !row.isSidechain &&
      said(row.message?.content, "text")) ||
    (row.type === "response_item" &&
      row.payload?.role === "assistant" &&
      said(row.payload.content, "output_text"))
  )
    s.lastActive = Math.max(s.lastActive ?? 0, time);
  if (row.type === "event_msg") {
    const p = row.payload;
    if (p?.type === "task_started") s.state = "running";
    if (p?.type === "task_complete" || p?.type === "task_completed")
      s.state = "idle";
    if (p?.type === "turn_aborted") s.state = "stopped";
  }
  watchAsk(f, row);
  let tokens: Tokens | undefined, id: string | undefined;
  if (
    s.source === "claude" &&
    row.type === "assistant" &&
    object(row.message?.usage)
  ) {
    const m = row.message,
      u = m.usage;
    if (m.model === "<synthetic>") return;
    if (typeof m.model === "string") s.model = m.model;
    const next: Tokens = {
      input: count(u.input_tokens),
      output: count(u.output_tokens),
      cached: count(u.cache_read_input_tokens),
      created: count(u.cache_creation_input_tokens),
      reasoning: count(u.output_tokens_details?.thinking_tokens),
    };
    // One API response can have several assistant content blocks with the same id.
    const key = m.id ?? row.uuid;
    if (!key) return;
    id = key;
    const prev = f.seen[key] ?? zero();
    tokens = zero();
    for (const k of Object.keys(next) as (keyof Tokens)[])
      tokens[k] = Math.max(0, next[k] - prev[k]);
    f.seen[key] = { ...next };
    for (const k of Object.keys(next) as (keyof Tokens)[])
      f.seen[key]![k] = Math.max(prev[k], next[k]);
  }
  if (s.source === "codex" && row.payload?.type === "token_count") {
    const p = row.payload,
      u = p.info?.total_token_usage;
    const limits = parseLimits(p.rate_limits, time);
    if (limits) f.limits = limits;
    if (object(u)) {
      const next: Tokens = {
        input: count(u.input_tokens),
        output: count(u.output_tokens),
        cached: count(u.cached_input_tokens),
        created: count(u.cache_write_input_tokens),
        reasoning: count(u.reasoning_output_tokens),
      };
      tokens = zero();
      for (const k of Object.keys(next) as (keyof Tokens)[])
        tokens[k] = Math.max(0, next[k] - f.cumulative[k]);
      // Token totals may reset after compaction; do not subtract already recorded usage.
      f.cumulative = next;
    }
  }
  if (tokens) {
    s.usageAvailable = true;
    add(s.tokens, tokens);
    const day = new Date(time).toLocaleDateString("en-CA");
    const key = day + "|" + s.model;
    const bucket = (f.buckets[key] ??= { day, model: s.model, tokens: zero() });
    add(bucket.tokens, tokens);
    if (id) f.slot[id] ??= key;
  }
}

export class Monitor {
  readonly roots: Profile[];
  readonly dataDir: string;
  private cache: Record<string, FileState> = {};
  private busy: Promise<void> | null = null;
  private updatedAt = 0;
  private errors: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private watchers: FSWatcher[] = [];
  private nudge?: ReturnType<typeof setTimeout>;
  private listeners = new Set<() => void>();
  private generation = 0;
  private copies?: { generation: number; byPath: Map<string, Copies> };
  /** Transcripts the folder watchers reported since the last tick. */
  private dirty = new Map<string, Profile>();
  private watched = new Set<string>();
  private scannedAt = 0;
  private savedAt = 0;
  private unsaved = false;
  private notifiedAt = 0;
  private nudged = false;
  private signals = new Map<string, { ino: number; mtime: number; size: number; value: any }>();
  constructor(options: { roots?: Profile[]; dataDir?: string } = {}) {
    this.roots = options.roots ?? dashboardProfiles();
    this.dataDir = options.dataDir ?? monitorDir();
    try {
      const saved = JSON.parse(
        readFileSync(join(this.dataDir, "metrics.json"), "utf8"),
      );
      if (saved.version === 5) this.cache = saved.files;
    } catch {}
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  start() {
    if (!this.timer) {
      // The tick reads only the transcripts these report; a walk of every
      // folder once a minute catches anything they miss.
      for (const root of this.roots)
        try {
          const w = watch(root.path, { recursive: true }, (_, name) => {
            if (name) this.dirty.set(join(root.path, String(name)), root);
          });
          w.on("error", () => {
            w.close();
            this.watched.delete(root.path);
          });
          w.unref();
          this.watchers.push(w);
          this.watched.add(root.path);
        } catch {}
      void this.refresh();
      this.timer = setInterval(() => {
        void this.refresh();
      }, 1500);
      this.timer.unref();
      // Hooks and live records change the moment a session starts or stops
      // working; the 1.5 s scan stays as the safety net.
      const own = [join(this.dataDir, "signals"), join(this.dataDir, "live")];
      for (const dir of own)
        try {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
        } catch {}
      const dirs = [
        ...own,
        ...this.roots
          .filter((p) => p.source === "claude")
          .map((p) => join(dirname(p.path), "sessions")),
      ];
      for (const dir of dirs)
        try {
          const w = watch(dir, () => {
            this.nudged = true;
            this.soon();
          });
          w.on("error", () => w.close());
          w.unref();
          this.watchers.push(w);
        } catch {}
    }
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const w of this.watchers) w.close();
    this.watchers = [];
    this.watched.clear();
    if (this.unsaved) this.save();
  }
  /** Refreshes soon, at most every 200 ms however often the folders change. */
  private soon() {
    if (this.nudge) return;
    this.nudge = setTimeout(
      () => {
        this.nudge = undefined;
        if (this.busy) this.soon();
        else void this.refresh();
      },
      Math.max(30, 200 - (Date.now() - this.updatedAt)),
    );
    this.nudge.unref();
  }
  refresh(): Promise<void> {
    if (!this.busy)
      this.busy = this.collect().finally(() => {
        this.busy = null;
      });
    return this.busy;
  }
  private async collect() {
    const active = new Set<string>(),
      walked = new Set<string>(),
      full = Date.now() - this.scannedAt > 60000,
      dirty = this.dirty;
    this.dirty = new Map();
    if (full) this.scannedAt = Date.now();
    this.errors = [];
    let changed = false;
    for (const profile of this.roots) {
      const walk = full || !this.watched.has(profile.path),
        paths = walk ? filesUnder(profile.path) : [];
      if (walk) walked.add(profile.id);
      else
        for (const [path, root] of dirty)
          if (root === profile && isTranscript(path)) paths.push(path);
      for (const path of paths) {
        if (walk) active.add(path);
        try {
          const st = statSync(path);
          let f = this.cache[path];
          if (
            !f ||
            f.ino !== st.ino ||
            st.size < f.size ||
            (st.size === f.size && st.mtimeMs !== f.mtime)
          ) {
            f = freshFile(profile, path, st.mtimeMs, st.ino);
            this.cache[path] = f;
          }
          if (st.size === f.size && st.mtimeMs === f.mtime) continue;
          // Only commit complete lines, so a later append safely completes a partial JSON record.
          const stream = createReadStream(path, {
            start: f.size,
            end: Math.max(0, st.size - 1),
          });
          let pending = Buffer.alloc(0),
            offset = f.size;
          for await (const chunk of stream) {
            pending = Buffer.concat([pending, chunk as Buffer]);
            let end: number;
            while ((end = pending.indexOf(10)) >= 0) {
              const line = pending.subarray(0, end).toString("utf8");
              pending = pending.subarray(end + 1);
              offset += end + 1;
              try {
                consume(f, JSON.parse(line), st.mtimeMs);
              } catch {}
            }
            if (pending.length > 16 * 1024 * 1024)
              throw new Error("Transcript line exceeds 16 MB");
          }
          f.size = offset;
          f.mtime = st.mtimeMs;
          f.session.updatedAt = Math.max(f.session.updatedAt, st.mtimeMs);
          changed = true;
        } catch (e) {
          if (!walk && (e as NodeJS.ErrnoException).code === "ENOENT") {
            if (this.cache[path]) {
              delete this.cache[path];
              changed = true;
            }
          } else this.errors.push(`${basename(path)}: ${(e as Error).message}`);
        }
      }
    }
    if (walked.size)
      for (const [key, f] of Object.entries(this.cache))
        if (!active.has(key) && (full || walked.has(f.session.profile))) {
          delete this.cache[key];
          changed = true;
        }
    this.updatedAt = Date.now();
    if (changed) {
      this.generation++;
      this.unsaved = true;
    }
    // The whole cache is megabytes of JSON; a minute of progress is cheap to redo.
    if (this.unsaved && Date.now() - this.savedAt > 60000) this.save();
    // Without news, a tick every 10 s still moves time-based states (stale).
    if (!changed && !this.nudged && Date.now() - this.notifiedAt < 10000) return;
    this.nudged = false;
    this.notifiedAt = Date.now();
    for (const listener of this.listeners)
      try {
        listener();
      } catch {}
  }
  private save() {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const path = join(this.dataDir, "metrics.json");
    writeFileSync(
      path + ".tmp",
      JSON.stringify({ version: 5, files: this.cache }),
      { mode: 0o600 },
    );
    renameSync(path + ".tmp", path);
    this.savedAt = Date.now();
    this.unsaved = false;
  }
  /** A signal file, parsed again only when it is replaced. */
  private signal(path: string, next: Monitor["signals"]) {
    const st = statSync(path),
      hit = this.signals.get(path);
    const entry =
      hit && hit.ino === st.ino && hit.mtime === st.mtimeMs && hit.size === st.size
        ? hit
        : {
            ino: st.ino,
            mtime: st.mtimeMs,
            size: st.size,
            value: JSON.parse(readFileSync(path, "utf8")),
          };
    next.set(path, entry);
    return entry.value;
  }
  /** Claude message IDs repeat across files (resumed or forked sessions, subagent
   *  copies). Per profile, the file whose session started first owns each ID; the
   *  others give back its tokens. Computed from the cache, so deleting the owner
   *  hands the credit to the next copy. */
  private duplicates() {
    if (this.copies?.generation === this.generation) return this.copies.byPath;
    const byPath = new Map<string, Copies>(),
      owners = new Map<string, Set<string>>();
    const files = Object.entries(this.cache)
      .filter(([, f]) => f.session.source === "claude")
      .sort(
        ([pa, a], [pb, b]) =>
          a.session.startedAt - b.session.startedAt || (pa < pb ? -1 : 1),
      );
    for (const [path, f] of files) {
      let owned = owners.get(f.session.profile);
      if (!owned) owners.set(f.session.profile, (owned = new Set()));
      for (const id in f.seen) {
        if (!owned.has(id)) {
          owned.add(id);
          continue;
        }
        const tokens = f.seen[id]!;
        let c = byPath.get(path);
        if (!c) byPath.set(path, (c = { tokens: zero(), buckets: {} }));
        add(c.tokens, tokens);
        const slot = f.slot[id];
        if (slot) add((c.buckets[slot] ??= zero()), tokens);
      }
    }
    this.copies = { generation: this.generation, byPath };
    return byPath;
  }
  /** Sessions that a live terminal process owns. Claude writes these itself; the
   *  Codex hook writes the same fields to <dataDir>/live. */
  liveRecords(): LiveRecord[] {
    const dirs = [
      ...this.roots
        .filter((p) => p.source === "claude")
        .map((p) => ({
          dir: join(dirname(p.path), "sessions"),
          profile: p.id,
        })),
      { dir: join(this.dataDir, "live"), profile: "" },
    ];
    const out: LiveRecord[] = [];
    for (const { dir, profile } of dirs) {
      let names: string[] = [];
      try {
        names = readdirSync(dir).filter((n) => n.endsWith(".json"));
      } catch {}
      for (const name of names) {
        try {
          const r = JSON.parse(readFileSync(join(dir, name), "utf8"));
          if (typeof r.pid !== "number" || typeof r.sessionId !== "string")
            continue;
          process.kill(r.pid, 0);
          out.push({
            profile: profile || String(r.profile ?? ""),
            sessionId: r.sessionId,
            pid: r.pid,
            procStart: typeof r.procStart === "string" ? r.procStart : "",
            tmux: String(r.tmux ?? "").match(/%\d+$/)?.[0] ?? "",
            status: String(r.status ?? ""),
            updatedAt: count(r.updatedAt),
          });
        } catch {}
      }
    }
    return out;
  }
  live(profile: string, sessionId: string) {
    return this.liveRecords().find(
      (r) => r.profile === profile && r.sessionId === sessionId,
    );
  }
  snapshot() {
    const sessions: ObservedSession[] = [],
      // One row per day, model, profile and folder, so the live stream can key it.
      usage = new Map<
        string,
        {
          day: string;
          model: string;
          profile: string;
          cwd: string;
          tokens: Tokens;
        }
      >(),
      days = new Map<
        string,
        { day: string; profile: string; tokens: Tokens }
      >(),
      models = new Map<
        string,
        { model: string; profile: string; tokens: Tokens }
      >();
    const profiles = this.roots.map((p) => ({
      ...p,
      tokens: zero(),
      sessions: 0,
      limits: undefined as Limits | undefined,
    }));
    const copies = this.duplicates();
    for (const [path, f] of Object.entries(this.cache)) {
      const profile = profiles.find((p) => p.id === f.session.profile);
      if (!profile) continue;
      const copy = copies.get(path);
      const s = {
        ...f.session,
        // Cached titles predate the fix, so clean them on the way out.
        title: stripPasteTags(f.session.title),
        tokens: copy
          ? minus(f.session.tokens, copy.tokens)
          : { ...f.session.tokens },
      };
      if (s.state === "running" && Date.now() - s.updatedAt > 120000)
        s.state = "stale";
      sessions.push(s);
      profile.sessions++;
      add(profile.tokens, s.tokens);
      if (
        f.limits &&
        (!profile.limits || f.limits.observedAt > profile.limits.observedAt)
      )
        profile.limits = f.limits;
      for (const [key, bucket] of Object.entries(f.buckets)) {
        const b = copy?.buckets[key]
          ? { ...bucket, tokens: minus(bucket.tokens, copy.buckets[key]) }
          : bucket;
        const uk = `${b.day}|${b.model}|${profile.id}|${s.cwd}`;
        if (!usage.has(uk))
          usage.set(uk, {
            day: b.day,
            model: b.model,
            profile: profile.id,
            cwd: s.cwd,
            tokens: zero(),
          });
        add(usage.get(uk)!.tokens, b.tokens);
        const dk = b.day + "|" + profile.id,
          mk = b.model + "|" + profile.id;
        if (!days.has(dk))
          days.set(dk, { day: b.day, profile: profile.id, tokens: zero() });
        add(days.get(dk)!.tokens, b.tokens);
        if (!models.has(mk))
          models.set(mk, {
            model: b.model,
            profile: profile.id,
            tokens: zero(),
          });
        add(models.get(mk)!.tokens, b.tokens);
      }
    }
    // Signals and live records name sessions by id; a scan of every session for each is slow.
    const byId = new Map<string, ObservedSession[]>();
    for (const s of sessions) {
      const list = byId.get(s.id);
      if (list) list.push(s);
      else byId.set(s.id, [s]);
    }
    const find = (id: unknown, profile?: string) =>
      byId
        .get(String(id))
        ?.find((s) => profile === undefined || s.profile === profile);
    const activity: any[] = [],
      costs: {
        profile: string;
        sessionId: string;
        value: number;
        updatedAt: number;
      }[] = [];
    try {
      const parsed: Monitor["signals"] = new Map();
      for (const name of readdirSync(join(this.dataDir, "signals"))) {
        if (!name.endsWith(".json")) continue;
        try {
          const signal = this.signal(join(this.dataDir, "signals", name), parsed);
          if (!profiles.some((p) => p.id === signal.profile)) continue;
          if (signal.kind === "statusline") {
            // The hook's profile tag can be wrong: a session in the home folder also
            // loads ~/.claude/settings.json as project settings. The transcript decides.
            const owner =
                find(signal.sessionId)?.profile ??
                signal.profile,
              p = profiles.find((p) => p.id === owner)!;
            const limits = parseLimits(signal.rate_limits, signal.updatedAt);
            if (
              limits &&
              (!p.limits || limits.observedAt > p.limits.observedAt)
            )
              p.limits = limits;
            if (typeof signal.cost?.total_cost_usd === "number")
              costs.push({
                profile: owner,
                sessionId: signal.sessionId,
                value: signal.cost.total_cost_usd,
                updatedAt: signal.updatedAt,
              });
          } else activity.push(signal);
        } catch {}
      }
      this.signals = parsed;
    } catch {}
    for (const a of activity) {
      const s = a.agentId
        ? (find(a.agentId, a.profile) ?? find("agent-" + a.agentId, a.profile))
        : find(a.sessionId, a.profile);
      if (s) {
        s.state =
          Date.now() - a.updatedAt > 120000 && a.state === "running"
            ? "stale"
            : a.state;
        s.updatedAt = Math.max(s.updatedAt, a.updatedAt);
      }
    }
    const states: Record<string, string> = {
      idle: "idle",
      busy: "running",
      running: "running",
      // The turn ended; a background command still runs (marked `shell`).
      shell: "idle",
      waiting: "waiting",
      waiting_for_input: "waiting",
    };
    for (const live of this.liveRecords()) {
      const s = find(live.sessionId, live.profile);
      if (!s) continue;
      s.state = states[live.status] ?? "unknown";
      if (live.status === "shell") s.shell = true;
      s.open = true;
      s.tmux = !!live.tmux || undefined;
      s.updatedAt = Math.max(s.updatedAt, live.updatedAt);
    }
    // Once the turn has ended: the agent's own `cfind ask`, else its last paragraph.
    // This holds while a background command still runs, too.
    for (const s of sessions) {
      const f = this.cache[s.path],
        ask = s.state === "idle" ? (f?.ask ?? askReply(f?.reply)) : undefined;
      if (ask) s.ask = ask;
    }
    return {
      updatedAt: this.updatedAt,
      collecting: !!this.busy,
      profiles,
      // dashboard/delta.js sorts merged lists the same way.
      sessions: sessions.sort(
        (a, b) => b.updatedAt - a.updatedAt || (a.path < b.path ? -1 : 1),
      ),
      days: [...days.values()].sort(
        (a, b) =>
          a.day.localeCompare(b.day) || a.profile.localeCompare(b.profile),
      ),
      models: [...models.values()],
      usage: [...usage.values()],
      activity,
      costs,
      errors: this.errors,
    };
  }
}
