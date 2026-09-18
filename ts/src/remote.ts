import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { debug } from "./debug.ts";
import { sanitizeTerminalText, type Line, type Session, type Style } from "./store.ts";

export type RemoteOS = "posix" | "windows";

interface ArgvOptions {
  batch?: boolean;
  tty?: boolean;
}

function hostsFilePath(): string {
  return join(homedir(), ".context-find", "hosts");
}

export const HOSTS_FILE = hostsFilePath();
const PINGS_FILE = join(homedir(), ".context-find", "pings.json");

function isPingsRecord(value: unknown): value is Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (v) => typeof v === "number" && Number.isFinite(v),
  );
}

function writeJsonAtomically(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  const tempPath = join(dir, `.${randomUUID()}.tmp`);
  try {
    const json = JSON.stringify(value);
    writeFileSync(tempPath, json, "utf8");
    renameSync(tempPath, path);
  } catch (error) {
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    } catch {
      /* ignore cleanup error */
    }
    throw error;
  }
}

function readPings(path = PINGS_FILE): Record<string, number> {
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isPingsRecord(data)) {
      return data;
    }
    return {};
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof SyntaxError
    ) {
      return {};
    }
    throw error;
  }
}

/** Unix seconds we last reached this host, or undefined if never. */
export function lastPingedAt(
  spec: string,
  path = PINGS_FILE,
): number | undefined {
  return readPings(path)[hostDisplayName(spec)];
}

function unixSecondsNow(): number {
  return Math.trunc(Date.now() / 1000);
}

export function recordPing(spec: string, path = PINGS_FILE): void {
  const pings = readPings(path);
  pings[hostDisplayName(spec)] = unixSecondsNow();
  writeJsonAtomically(path, pings);
}

export function readHosts(path = HOSTS_FILE): string[] {
  if (!existsSync(path)) {
    debug("remote hosts loaded: count=0");
    return [];
  }
  const hosts = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  debug(`remote hosts loaded: count=${hosts.length}`);
  return hosts;
}

export function buildHostSpec(
  target: string,
  keyFile = "",
  os: RemoteOS = "posix",
  python = "",
): string {
  const t = target.trim();
  const k = keyFile.trim();
  const ssh = k ? `${t} -i ${k}` : t;
  const p = python.trim();
  return `${ssh} # context-find:os=${os}${p ? ` python=${p}` : ""}`;
}

export function appendHostSpec(spec: string, path = HOSTS_FILE): void {
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const gap = existing && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(path, `${gap}${spec}\n`);
  debug("remote host configuration updated");
}

export function splitSpecTokens(spec: string): string[] {
  const ssh = spec.replace(
    /\s+#\s+context-find:os=(?:posix|windows)(?:\s+python=.+)?\s*$/,
    "",
  );
  const tokens = ssh.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return tokens.map((token) => {
    const bare = token.replace(/^["']|["']$/g, "");
    return bare.startsWith("~") ? homedir() + bare.slice(1) : bare;
  });
}

export function hostDisplayName(spec: string): string {
  return splitSpecTokens(spec)[0] ?? spec;
}

function specPython(spec: string): string | undefined {
  return spec
    .match(/#\s+context-find:os=(?:posix|windows)\s+python=(.+)$/)?.[1]
    ?.trim();
}

/**
 * An ssh target followed by any ssh options, so a host needing a key, a port
 * or a jump box works with no ~/.ssh/config entry.
 */
export function buildSshArgv(
  spec: string,
  remote: string,
  options: ArgvOptions = {},
): string[] {
  const { batch = true, tty = false } = options;
  const tokens = splitSpecTokens(spec);
  if (tokens.length === 0) throw new Error("empty ssh host");
  const argv = ["ssh"];
  if (tty) argv.push("-t");
  if (batch) argv.push("-o", "BatchMode=yes");
  argv.push("-o", "ConnectTimeout=10");
  return [...argv, ...tokens.slice(1), tokens[0]!, remote];
}

export function remoteAgentCommand(spec: string, args: string[]): string {
  const windows = /#\s+context-find:os=windows(?:\s|$)/.test(spec);
  const pinned = specPython(spec);
  const python =
    pinned ??
    (windows ? "py -3" : '"$(command -v python3 || command -v python)"');
  const mode = pinned ? "pinned" : windows ? "Windows" : "POSIX";
  debug(`${hostDisplayName(spec)}: using ${mode} Python`);
  const encoded = Buffer.from(JSON.stringify(args)).toString("base64url");
  return `${python} - --args-base64 ${encoded}`;
}

export function readAgentSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "store.py");
  if (existsSync(path)) {
    debug("remote agent source loaded");
    return readFileSync(path, "utf8");
  }
  throw new Error("cannot find store.py to send to the remote host");
}

export function authHint(stderr: string, target: string): string | undefined {
  if (/host key verification failed/i.test(stderr)) {
    return `run: ssh ${target}  once to accept its host key`;
  }
  if (
    /permission denied|too many authentication failures|no such identity|no more authentication methods/i.test(
      stderr,
    )
  ) {
    return "auth failed: ssh-add your key or fix the host spec; BatchMode blocks passphrase/password prompts";
  }
  return undefined;
}

const MAX_OUTPUT_BYTES = 50 * 1024 * 1024; // 50MB bound on SSH output

function runRemoteAgent(
  spec: string,
  args: string[],
  timeoutMs = 90_000,
): Promise<unknown> {
  const remote = remoteAgentCommand(spec, args);
  const [command, ...argv] = buildSshArgv(spec, remote);
  const label = hostDisplayName(spec);
  const started = Date.now();
  const operation = args[0]?.replace(/^--/, "") ?? "agent";
  debug(`${label}: remote ${operation} started`);
  return new Promise((resolve, reject) => {
    const child = spawn(command!, argv, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killedForSize = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      debug(`${label}: killed, no answer after ${timeoutMs}ms`);
      reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES && !killedForSize) {
        killedForSize = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error(`remote output exceeded size limit (${MAX_OUTPUT_BYTES} bytes)`));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > MAX_OUTPUT_BYTES && !killedForSize) {
        killedForSize = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error(`remote stderr exceeded size limit (${MAX_OUTPUT_BYTES} bytes)`));
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      debug(`${label}: could not launch ssh: ${error.message}`);
      reject(
        new Error(
          error.message.includes("ENOENT")
            ? "no ssh client on PATH"
            : error.message,
        ),
      );
    });
    child.on("close", (code) => {
      if (killedForSize) return;
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (code !== 0) {
        const detail = stderr.trim().split("\n").filter(Boolean).pop();
        const hint = authHint(stderr, label);
        debug(
          `${label}: remote ${operation} failed: status=${code}, duration=${ms}ms, stderr-bytes=${stderr.length}`,
        );
        const base = (detail ?? `ssh exited ${code}`).slice(0, 160);
        return reject(new Error(hint ? `${base} (${hint})` : base));
      }
      try {
        const parsed = JSON.parse(stdout);
        debug(
          `${label}: remote ${operation} finished: duration=${ms}ms, response-bytes=${stdout.length}`,
        );
        resolve(parsed);
      } catch {
        debug(
          `${label}: remote ${operation} returned invalid output: duration=${ms}ms, response-bytes=${stdout.length}, stderr-bytes=${stderr.length}`,
        );
        reject(
          new Error("remote sent no usable output, is python installed there?"),
        );
      }
    });

    child.stdin.end(readAgentSource());
  });
}

export function validateRemoteSessions(data: unknown, spec: string): Session[] {
  if (!Array.isArray(data)) {
    throw new Error("remote agent returned invalid scan response: expected array");
  }
  const sessions: Session[] = [];
  for (const item of data) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as Record<string, unknown>).path === "string" &&
      typeof (item as Record<string, unknown>).cwd === "string" &&
      typeof (item as Record<string, unknown>).branch === "string" &&
      typeof (item as Record<string, unknown>).summary === "string" &&
      typeof (item as Record<string, unknown>).mtime === "number" &&
      Number.isFinite((item as Record<string, unknown>).mtime)
    ) {
      const row = item as Record<string, unknown>;
      const source = (row.source === "codex" || row.source === "claude")
        ? (row.source as "claude" | "codex")
        : "claude";
      sessions.push({
        path: row.path as string,
        cwd: row.cwd as string,
        branch: row.branch as string,
        summary: row.summary as string,
        mtime: row.mtime as number,
        host: spec,
        source,
        sid: typeof row.sid === "string" ? row.sid : "",
      });
    }
  }
  return sessions;
}

export function validateConversationCounts(
  data: unknown,
): Record<string, number> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("remote agent returned invalid conversation counts: expected object");
  }
  const record = data as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = value;
    }
  }
  return result;
}

export function validateRenderLines(data: unknown): Line[] {
  if (!Array.isArray(data)) {
    throw new Error("remote agent returned invalid render response: expected array");
  }
  const lines: Line[] = [];
  const validStyles = new Set(["user", "assistant", "tool", "meta", "text"]);
  for (const item of data) {
    if (
      Array.isArray(item) &&
      item.length === 2 &&
      typeof item[0] === "string" &&
      typeof item[1] === "string"
    ) {
      const style = (validStyles.has(item[0]) ? item[0] : "text") as Style;
      lines.push([style, sanitizeTerminalText(item[1])]);
    }
  }
  return lines;
}

export async function searchRemoteTranscripts(
  spec: string,
  query = "",
): Promise<Session[]> {
  const result = await runRemoteAgent(spec, ["--scan", query]);
  return validateRemoteSessions(result, spec);
}

export async function remoteConversationCounts(
  spec: string,
): Promise<Record<string, number>> {
  const result = await runRemoteAgent(
    spec,
    ["--conversation-counts"],
    30_000,
  );
  return validateConversationCounts(result);
}

export async function renderRemoteTranscript(
  spec: string,
  path: string,
  width: number,
  showAll: boolean,
  asciiOnly: boolean,
): Promise<Line[]> {
  const result = await runRemoteAgent(spec, [
    "--render",
    path,
    String(width),
    showAll ? "1" : "0",
    asciiOnly ? "1" : "0",
  ]);
  return validateRenderLines(result);
}

export function quoteForPosixShell(value: string): string {
  return "'" + value.split("'").join(`'"'"'`) + "'";
}

function powershellQuote(value: string): string {
  return "'" + value.split("'").join("''") + "'";
}

export function buildResumeCommand(
  spec: string,
  cwd: string,
  sessionId: string,
  argv: string[],
): string {
  if (/#\s+context-find:os=windows(?:\s|$)/.test(spec)) {
    const script = [
      `Set-Location -LiteralPath ${powershellQuote(cwd)}`,
      `& ${[...argv, sessionId].map(powershellQuote).join(" ")}`,
    ].join("\n");
    return `powershell.exe -NoProfile -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  }
  const inner = `cd ${quoteForPosixShell(cwd)} && ${argv.join(" ")} ${quoteForPosixShell(sessionId)}`;

  return `$SHELL -lc ${quoteForPosixShell(inner)}`;
}

export function resumeRemote(
  spec: string,
  cwd: string,
  sessionId: string,
  argv: string[],
): number {
  const remote = buildResumeCommand(spec, cwd, sessionId, argv);
  const [command, ...rest] = buildSshArgv(spec, remote, {
    batch: false,
    tty: true,
  });
  debug(`${hostDisplayName(spec)}: remote resume started`);
  const done = spawnSync(command!, rest, { stdio: "inherit" });
  const status = done.status ?? 1;
  debug(`${hostDisplayName(spec)}: resume exited ${status}`);
  return status;
}
