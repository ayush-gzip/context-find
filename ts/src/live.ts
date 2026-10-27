/** Input to sessions that a terminal process owns: type into its tmux pane, or
 *  stop the process so the dashboard can continue the session. */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LiveRecord } from "./monitor.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = (cmd: string, args: string[], input?: string, timeout = 3000) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    input,
    timeout,
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, TZ: "UTC" },
  }).trim();
const quiet = (cmd: string, args: string[]) => {
  try {
    return run(cmd, args);
  } catch {
    return "";
  }
};

/** launchd starts the daemon without Homebrew on PATH. */
function tmuxBin() {
  if (process.env["CFIND_TMUX_BIN"]) return process.env["CFIND_TMUX_BIN"];
  const dirs = [
    ...(process.env["PATH"] ?? "").split(":"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const found = dirs.map((d) => join(d, "tmux")).find((p) => existsSync(p));
  if (!found) throw new Error("tmux was not found");
  return found;
}

/** Start time in the format Claude records: `ps -o lstart=` in UTC. */
export const procStart = (pid: number) =>
  quiet("ps", ["-o", "lstart=", "-p", String(pid)]).replace(/\s+/g, " ");

// "shell": the turn ended but background shell tasks still run; the prompt takes input.
const BUSY = ["busy", "running", "shell"];
/** Keys typed into a permission or question menu would pick an option. */
function ready(r: LiveRecord | undefined, busyOk: boolean) {
  if (!r) throw new Error("This session is no longer open in a terminal");
  if (r.status === "idle" || (busyOk && BUSY.includes(r.status))) return;
  throw new Error(
    r.status === "waiting"
      ? "The session is waiting for an answer in its terminal"
      : "The session is replying in its terminal. Send when it finishes",
  );
}

/** A PID can be reused, so the recorded start time must match before any action. */
function verify(r: LiveRecord, busyOk = false) {
  ready(r, busyOk);
  if (!r.procStart || procStart(r.pid) !== r.procStart.replace(/\s+/g, " "))
    throw new Error("Could not confirm the terminal process for this session");
}

function ancestors(pid: number) {
  const out: number[] = [];
  for (let p = pid; p > 1 && out.length < 20; ) {
    out.push(p);
    p = Number(quiet("ps", ["-o", "ppid=", "-p", String(p)])) || 0;
  }
  return out;
}

/** `current` re-reads the record: a menu can open while the text is pasted, and
 *  then Enter must not be sent. */
export async function sendToPane(
  r: LiveRecord,
  text: string,
  current: () => LiveRecord | undefined = () => r,
) {
  if (!r.tmux) throw new Error("This session is not in tmux");
  verify(r, true);
  const tmux = tmuxBin(),
    panePid = Number(
      quiet(tmux, ["display-message", "-p", "-t", r.tmux, "#{pane_pid}"]),
    );
  if (!panePid || !ancestors(r.pid).includes(panePid))
    throw new Error("The tmux pane no longer runs this session");
  // Control characters could end the bracketed paste early and act as keys.
  const clean = text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""),
    buffer = "cfind-" + randomBytes(4).toString("hex");
  ready(current(), true);
  run(tmux, ["load-buffer", "-b", buffer, "-"], clean);
  run(tmux, ["paste-buffer", "-d", "-p", "-r", "-b", buffer, "-t", r.tmux]);
  await sleep(150);
  try {
    ready(current(), true);
  } catch (e) {
    throw new Error(
      `${(e as Error).message}. Your text is in its input box but was not sent`,
    );
  }
  run(tmux, ["send-keys", "-t", r.tmux, "Enter"]);
}

export async function takeOver(r: LiveRecord) {
  if (r.tmux) throw new Error("This session is in tmux. Send to it instead");
  verify(r);
  process.kill(r.pid, "SIGTERM");
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    try {
      process.kill(r.pid, 0);
    } catch {
      return;
    }
  }
  throw new Error("The terminal session did not stop");
}

/** Which process has a Codex session file open. The shared background helper
 *  (`codex app-server --listen unix://`) keeps each loaded thread's file open; a
 *  Codex window started with --no-daemon keeps its own. */
export function codexHolder(path: string): "helper" | "other" | "none" {
  let pids: string[];
  try {
    pids = run(process.env["CFIND_LSOF_BIN"] || "/usr/sbin/lsof", [
      "-t",
      "--",
      path,
    ])
      .split(/\s+/)
      .filter(Boolean);
  } catch (e: any) {
    // lsof exits 1 when no process has the file open.
    if (e?.status === 1) return "none";
    throw new Error("Could not check which process has this session open");
  }
  if (!pids.length) return "none";
  return pids.some((pid) =>
    /\bapp-server\b.*--listen\s+unix:/.test(
      quiet("ps", ["-o", "command=", "-p", pid]),
    ),
  )
    ? "helper"
    : "other";
}

/** Documented: the helper runs the message now, or after the current turn. */
export function queueCodex(thread: string, text: string) {
  run(
    process.env["CFIND_CODEX_BIN"] ?? "codex",
    ["queue", "--thread", thread, "--message", text.replace(/\0/g, "")],
    undefined,
    15000,
  );
}
