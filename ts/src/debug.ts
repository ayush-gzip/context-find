import { appendFileSync } from "node:fs";

// Read the environment at invocation time because --debug is parsed after imports.
export function debug(message: string): void {
  if (process.env["CONTEXT_FIND_DEBUG"]) {
    const safe = message.slice(0, 500).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
    const line = `[cfind] ${safe}\n`;
    process.stderr.write(line);
    const file = process.env["CONTEXT_FIND_DEBUG_FILE"];
    if (file) {
      try {
        appendFileSync(file, line);
      } catch {
        /* logging must never break the run */
      }
    }
  }
}
