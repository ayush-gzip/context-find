import { relativeTime, sanitizeTerminalText } from "./store.ts";

export function printTerminalText(text = ""): void {
  console.log(sanitizeTerminalText(text));
}

export function printTerminalError(text: string): void {
  console.error(sanitizeTerminalText(text));
}

/** One row of the `--list-machines` table. */
export function machineRow(
  name: string,
  tally: Record<string, number> | null,
  status: string,
): string[] {
  name = sanitizeTerminalText(name);
  status = sanitizeTerminalText(status);
  if (!tally) return [name, "-", "-", "-", "-", status];
  const claude = tally["claude"] ?? 0;
  const codex = tally["codex"] ?? 0;
  return [
    name,
    String(claude),
    String(codex),
    String(claude + codex),
    relativeTime(tally["last"]),
    status,
  ];
}
