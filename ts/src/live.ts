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

/** Starts a command in a new window of the detached tmux session `cfind` on the
 *  default server; the session is made on first use. tmux runs the arguments
 *  without a shell. Returns the new pane and its process. */
export function startInTmux(cwd: string, command: string[]) {
  const tmux = tmuxBin(),
    // Not run(): its TZ=UTC would stay in a tmux server that this call starts.
    start = (args: string[]) =>
      execFileSync(
        tmux,
        [...args, "-P", "-F", "#{pane_id} #{pane_pid}", "-c", cwd, ...command],
        { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
  let line: string;
  try {
    line = start(["new-window", "-d", "-t", "cfind:"]);
  } catch {
    try {
      line = start(["new-session", "-d", "-s", "cfind", "-x", "160", "-y", "45"]);
    } catch {
      // Another start made the session in between.
      line = start(["new-window", "-d", "-t", "cfind:"]);
    }
  }
  const [pane = "", pid = ""] = line.split(" ");
  if (!/^%\d+$/.test(pane) || !Number(pid))
    throw new Error("tmux did not start the terminal");
  return { pane, pid: Number(pid) };
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

function verify(r: LiveRecord, busyOk = false) {
  ready(r, busyOk);
  sameProcess(r);
}

/** A PID can be reused, so the recorded start time must match before any action. */
function sameProcess(r: LiveRecord) {
  if (!r.procStart || procStart(r.pid) !== r.procStart.replace(/\s+/g, " "))
    throw new Error("Could not confirm the terminal process for this session");
}

/** tmux reuses pane ids, so the pane must still run this session's process. */
function checkPane(r: LiveRecord) {
  const tmux = tmuxBin(),
    panePid = Number(
      quiet(tmux, ["display-message", "-p", "-t", r.tmux!, "#{pane_pid}"]),
    );
  if (!panePid || !ancestors(r.pid).includes(panePid))
    throw new Error("The tmux pane no longer runs this session");
  return tmux;
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
  const tmux = checkPane(r);
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

/** The pane's screen as plain text, for menus the transcript does not record,
 *  and whether its window has other panes and is zoomed on this one. */
export function capturePane(r: LiveRecord) {
  if (!r.tmux) throw new Error("This session is not in tmux");
  sameProcess(r);
  const tmux = checkPane(r),
    // No -e: tmux leaves out colours and other escape codes.
    screen = run(tmux, ["capture-pane", "-p", "-t", r.tmux]),
    [panes, zoomed, active] = run(tmux, [
      "display-message",
      "-p",
      "-t",
      r.tmux,
      "#{window_panes} #{window_zoomed_flag} #{pane_active}",
    ]).split(" ");
  return {
    screen: screen
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
      .split("\n")
      .slice(-40)
      .join("\n"),
    split: Number(panes) > 1,
    zoomed: zoomed === "1" && active === "1",
  };
}

// Panes this daemon zoomed: the pane that had the keyboard, and whether that
// pane was zoomed.
const zooms = new Map<string, { pane: string; zoomed: boolean }>();

/** Zooms the pane to fill its tmux window, as prefix z does, so a short pane
 *  shows a whole menu. Zooming makes it the window's active pane, so unzooming
 *  gives the keyboard back to the pane that had it. */
export function zoomPane(r: LiveRecord, on: boolean) {
  if (!r.tmux) throw new Error("This session is not in tmux");
  sameProcess(r);
  const tmux = checkPane(r),
    pane = r.tmux,
    zoom = (p: string) => run(tmux, ["resize-pane", "-Z", "-t", p]),
    [, flag, active = ""] =
      run(tmux, [
        "list-panes",
        "-t",
        pane,
        "-F",
        "#{pane_active} #{window_zoomed_flag} #{pane_id}",
      ])
        .split("\n")
        .find((l) => l.startsWith("1 "))
        ?.split(" ") ?? [],
    zoomed = flag === "1",
    mine = zoomed && active === pane;
  if (on) {
    if (mine) return;
    // resize-pane -Z unzooms a window that is zoomed on any pane.
    if (zoomed) zoom(active);
    zoom(pane);
    zooms.set(pane, { pane: active, zoomed });
    return;
  }
  const before = zooms.get(pane);
  zooms.delete(pane);
  // Someone changed the window since; leave it as it is.
  if (!mine) return;
  zoom(pane);
  if (!before || before.pane === pane) return;
  // That pane may have closed since.
  quiet(tmux, ["select-pane", "-t", before.pane]);
  if (before.zoomed) quiet(tmux, ["resize-pane", "-Z", "-t", before.pane]);
}

// Enough to move through a menu and pick or close it. Letters are menu keys too,
// such as s for "this session only" in Claude's model picker.
const KEYS = new Set([
  "Up",
  "Down",
  "Left",
  "Right",
  "Enter",
  "Escape",
  "Tab",
  "BTab",
  "Space",
  ..."123456789",
  ..."abcdefghijklmnopqrstuvwxyz",
]);

// Claude's terminal: Ctrl+X Ctrl+S sends the queued messages now, stopping the
// reply or the ! command that runs.
const COMBOS: Record<string, string[]> = { "send-now": ["C-x", "C-s"] };

/** One named key into the pane, such as Down or Enter in a terminal menu. */
export function sendKey(r: LiveRecord, key: string) {
  const keys = COMBOS[key] ?? (KEYS.has(key) ? [key] : undefined);
  if (!keys) throw new Error("Unknown key");
  if (!r.tmux) throw new Error("This session is not in tmux");
  sameProcess(r);
  run(checkPane(r), ["send-keys", "-t", r.tmux, ...keys]);
}

/** Esc stops the reply or the ! command. A stopped ! command comes back into the
 *  input box in shell mode, and the next message would be added to it, so
 *  Ctrl+U clears the text and Backspace leaves shell mode. */
export async function stopPane(r: LiveRecord) {
  sendKey(r, "Escape");
  await sleep(300);
  run(checkPane(r), ["send-keys", "-t", r.tmux!, "C-u", "BSpace"]);
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
