/** Row formatting and scroll maths, kept out of the JSX so they stay testable. */
import { relativeTime, prettyPath, type Session } from "./store.ts";
import { hostDisplayName } from "./remote.ts";

interface Cell {
  stamp: string;
  source: string;
  host: string;
  folder: string;
  branch: string;
  summary: string;
}

export const COLUMN_WIDTHS = {
  stamp: 12,
  source: 7,
  machine: 11,
  folder: 25,
  branch: 10,
} as const;

/** Keep the cursor inside the visible window. */
export function clampScrollTop(top: number, cursor: number, view: number): number {
  let next = Math.min(top, cursor);
  if (cursor >= next + view) next = cursor - view + 1;
  return Math.max(next, 0);
}

export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}

/** Ctrl+J/K still move when j/k themselves are filter text. */
function isCtrlChord(input: string, key: { ctrl?: boolean }, letter: string): boolean {
  return Boolean(key.ctrl) && input.toLowerCase() === letter;
}

export function verticalMotion(
  input: string, key: { upArrow: boolean; downArrow: boolean; ctrl?: boolean },
): number {
  if (key.upArrow || input === "k" || isCtrlChord(input, key, "k")) return -1;
  if (key.downArrow || input === "j" || isCtrlChord(input, key, "j")) return 1;
  return 0;
}

type ListAction = "up" | "down" | "page-up" | "page-down" | "resume" | "view" |
  "search" | "normal" | "type" | "backspace" | "list-machines" | "deep" | "quit" | "none";

export function listAction(input: string, key: {
  upArrow?: boolean; downArrow?: boolean; pageUp?: boolean; pageDown?: boolean;
  return?: boolean; escape?: boolean; delete?: boolean; backspace?: boolean;
  tab?: boolean; ctrl?: boolean; meta?: boolean;
}, searching: boolean): ListAction {
  if (key.ctrl && input === "c") return "quit";
  if (key.ctrl && input === "d") return "deep"; // full-content search, works in any mode
  if (isCtrlChord(input, key, "k")) return "up";
  if (isCtrlChord(input, key, "j")) return "down";
  if (key.escape) return searching ? "normal" : "quit";
  if (key.return) return "resume";
  if (key.tab) return "view";
  if (key.upArrow || (!searching && input === "k")) return "up";
  if (key.downArrow || (!searching && input === "j")) return "down";
  if (key.pageUp) return "page-up";
  if (key.pageDown) return "page-down";
  if (searching) {
    if (key.delete || key.backspace) return "backspace";
    return input && !key.ctrl && !key.meta ? "type" : "none";
  }
  if (input === "v") return "view";
  if (input === "r") return "resume";
  if (input === "/") return "search";
  if (input === "l") return "list-machines";
  return "none";
}

export function tableHeader(width: number): string {
  return ("DATE".padEnd(COLUMN_WIDTHS.stamp) + "  " +
    "AGENT".padEnd(COLUMN_WIDTHS.source) + "MACHINE".padEnd(COLUMN_WIDTHS.machine) +
    "DIR".padEnd(COLUMN_WIDTHS.folder) + "BRANCH".padEnd(COLUMN_WIDTHS.branch) +
    "PREVIEW").slice(0, width);
}

export function machineRow(
  name: string, tally: Record<string, number> | null, status: string,
): string[] {
  if (!tally) return [name, "-", "-", "-", "-", status];
  const claude = tally["claude"] ?? 0;
  const codex = tally["codex"] ?? 0;
  return [name, String(claude), String(codex), String(claude + codex),
          relativeTime(tally["last"]), status];
}

export function machineLine(cells: string[], width: number): string {
  const widths = [20, 8, 7, 7, 14];
  const text = cells.slice(0, 5).map((cell, index) => {
    const size = widths[index]! - 1;
    const shown = cell.length > size ? cell.slice(0, size - 1) + "…" : cell;
    const aligned = index > 0 && index < 4 ? shown.padStart(size) : shown.padEnd(size);
    return aligned + " ";
  }).join("") + cells[5];
  return text.slice(0, width);
}

const pad = (value: number) => String(value).padStart(2, "0");

export function sessionRow(session: Session): Cell {
  const when = new Date(session.mtime * 1000);
  const month = when.toLocaleString("en", { month: "short" });
  const stamp = `${month} ${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;

  let folder = prettyPath(session.cwd);
  const maxFolder = COLUMN_WIDTHS.folder - 1;
  if (folder.length > maxFolder) folder = "…" + folder.slice(1 - maxFolder); // keep identifying tail
  const maxBranch = COLUMN_WIDTHS.branch - 1;
  const branch = session.branch.length > maxBranch
    ? session.branch.slice(0, maxBranch - 1) + "…"
    : session.branch;

  return {
    stamp,
    source: session.source,
    host: session.host != null ? hostDisplayName(session.host).slice(0, 10) : "local",
    folder,
    branch,
    summary: session.summary,
  };
}
