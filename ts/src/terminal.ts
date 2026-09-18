import { sanitizeTerminalText } from "./store.ts";

export function printTerminalText(text = ""): void {
  console.log(sanitizeTerminalText(text));
}

export function printTerminalError(text: string): void {
  console.error(sanitizeTerminalText(text));
}
