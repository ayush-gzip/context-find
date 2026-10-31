/** Structured local transcripts for the dashboard chat view. Remote sessions keep
 *  the line renderer, because store.py is the copy that runs on remote machines. */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { askCommand, askScript } from "./asks.ts";
import {
  codexText,
  plainText,
  sanitizeTerminalText,
  startsWithCodexSkipped,
  startsWithSkipped,
  stripReminders,
  toolArg,
} from "./store.ts";

export interface ChatTool {
  name: string;
  input: string;
  output?: string;
  error?: boolean;
}
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "note";
  text: string;
  time?: number;
  tool?: ChatTool;
  /** Data URLs of images in a user message. */
  images?: string[];
  /** The agent's `cfind ask` question, shown in full in place of the command. */
  question?: boolean;
}

const MAX_MESSAGES = 400,
  KEEP_MESSAGES = 1000,
  MAX_TEXT = 100000,
  MAX_TOOL_TEXT = 8000,
  MAX_IMAGE_CHARS = 8 * 1024 * 1024;

const clip = (text: string, max: number) =>
  text.length > max
    ? text.slice(0, max) + `\n… ${text.length - max} more characters`
    : text;
const clean = (text: string, max = MAX_TEXT) =>
  clip(sanitizeTerminalText(text), max);
const stamp = (value: unknown) => {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? undefined : time;
};
/** Claude Code wraps pasted text in these tags; the text inside is the user's.
 *  A title cut at its length limit can end inside a tag, so `>` is optional. */
export const stripPasteTags = (text: string) =>
  text.replace(/<\/?pasted_content\b[^>]*>?/g, "");
const pretty = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2);

/** Tool results arrive as a string, text blocks, or tool references. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b?.type === "text" || b?.type === "input_text"
        ? (b.text ?? "")
        : b?.type === "tool_reference"
          ? `Loaded tool ${b.tool_name}`
          : b?.type === "image" || b?.type === "input_image"
            ? "[Image]"
            : "",
    )
    .filter(Boolean)
    .join("\n");
}

const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp)$/,
  DATA_URL = /^data:(image\/[a-z]+);base64,[A-Za-z0-9+/]+=*$/;
/** Only image types with plain base64 become data URLs. */
function images(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content) {
    const src = b?.source;
    if (
      b?.type === "image" &&
      src?.type === "base64" &&
      IMAGE_TYPE.test(src.media_type) &&
      /^[A-Za-z0-9+/]+=*$/.test(src.data)
    )
      out.push(`data:${src.media_type};base64,${src.data}`);
    if (b?.type === "input_image" && typeof b.image_url === "string") {
      const m = b.image_url.match(DATA_URL);
      if (m && IMAGE_TYPE.test(m[1])) out.push(b.image_url);
    }
  }
  return out;
}

/** Older Codex shell outputs are JSON with the text under "output". */
function codexOutput(output: unknown): string {
  if (typeof output !== "string") return resultText(output);
  try {
    const parsed = JSON.parse(output);
    if (typeof parsed?.output === "string") return parsed.output;
  } catch {}
  return output;
}

function codexSummary(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const arg =
      toolArg(parsed) ||
      (Array.isArray(parsed?.cmd) ? parsed.cmd.join(" ") : parsed?.cmd);
    if (typeof arg === "string" && arg) return arg;
  } catch {}
  // Code-mode calls wrap the command in JavaScript, e.g. exec_command({cmd:"ls"}).
  const cmd = raw.match(/\bcmd"?\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (cmd)
    try {
      return JSON.parse(`"${cmd[1]}"`);
    } catch {}
  return raw.trim().split("\n")[0] ?? "";
}

/** A /command line or its output, in the tags Claude Code logs them with. */
function localCommand(
  text: string,
): { command?: string; output: string } | undefined {
  const name = /^<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  if (name) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1];
    return {
      command: clean(`${name[1]} ${args ?? ""}`.trim(), 300),
      output: "",
    };
  }
  const output =
    /^<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/.exec(text);
  return output ? { output: output[2]! } : undefined;
}

/** Message state for one transcript, built one record at a time. */
class Parser {
  out: ChatMessage[] = [];
  /** Messages trimmed from the front; they stay counted in `omitted`. */
  dropped = 0;
  /** New or changed since the caller last cleared it. */
  changed = new Set<ChatMessage>();
  private tools = new Map<string, ChatMessage>();
  // A command typed in Claude Code's own terminal (/model, /cost) is logged as a
  // caveat, then the command and its output, all with the caveat's promptId.
  private localPrompts = new Set<unknown>();
  private localNote?: ChatMessage;
  readonly codex: boolean;
  constructor(codex: boolean) {
    this.codex = codex;
  }

  private get count() {
    return this.dropped + this.out.length;
  }
  private push(m: ChatMessage) {
    this.out.push(m);
    this.changed.add(m);
  }
  private tool(
    id: string,
    name: string,
    summary: string,
    input: string,
    time?: number,
  ) {
    const m: ChatMessage = {
      id,
      role: "tool",
      text: clean(summary.split(/\s+/).join(" "), 300),
      time,
      tool: { name: clean(name, 200), input: clean(input, MAX_TOOL_TEXT) },
    };
    this.tools.set(id, m);
    this.push(m);
  }
  /** The agent's `cfind ask` question: its own message, in full, not a cut-off
   *  command row. The call's output is dropped with it. */
  private ask(id: string, question: string, time?: number) {
    this.push({
      id,
      role: "assistant",
      text: clean(question),
      time,
      question: true,
    });
  }
  private result(id: string, output: string, error = false) {
    const m = this.tools.get(id);
    if (m?.tool) {
      m.tool.output = clean(output, MAX_TOOL_TEXT);
      m.tool.error = error || undefined;
      this.changed.add(m);
    }
  }
  /** Keeps memory flat for long transcripts; only the newest messages are shown. */
  trim() {
    if (this.out.length <= KEEP_MESSAGES * 2) return;
    const gone = this.out.splice(0, this.out.length - KEEP_MESSAGES);
    this.dropped += gone.length;
    for (const m of gone) {
      if (m.tool) this.tools.delete(m.id);
      this.changed.delete(m);
    }
  }

  handle(entry: Record<string, any>) {
    if (this.codex) this.codexEntry(entry);
    else this.claudeEntry(entry);
  }

  private codexEntry(entry: Record<string, any>) {
    const p = entry["payload"] ?? {},
      time = stamp(entry["timestamp"]);
    if (entry["type"] !== "response_item") return;
    const id = String(p.id ?? p.call_id ?? this.count);
    if (p.type === "message") {
      const text = codexText(p).trim(),
        pics = p.role === "user" ? images(p.content) : [];
      if (!text && !pics.length) return;
      if (p.role === "user" && !startsWithCodexSkipped(text))
        this.push({
          id,
          role: "user",
          text: clean(text),
          time,
          images: pics.length ? pics : undefined,
        });
      if (p.role === "assistant")
        this.push({ id, role: "assistant", text: clean(text), time });
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      const raw = String(p.arguments ?? p.input ?? "");
      let asked: string | undefined;
      // A script with more than the one call keeps its tool row.
      if (p.type === "custom_tool_call")
        asked =
          raw.match(/exec_command/g)?.length === 1
            ? askScript(raw, true)
            : undefined;
      else
        try {
          const a = JSON.parse(raw),
            cmd = a.cmd ?? a.command;
          asked = askCommand(
            Array.isArray(cmd) ? cmd.join(" ") : String(cmd ?? ""),
            true,
          );
        } catch {}
      if (asked) return this.ask(String(p.call_id ?? id), asked, time);
      this.tool(
        String(p.call_id ?? id),
        String(p.name ?? "tool"),
        codexSummary(raw),
        pretty(raw),
        time,
      );
    } else if (p.type === "local_shell_call") {
      const command = [p.action?.command ?? []].flat().join(" ");
      this.tool(String(p.call_id ?? id), "shell", command, command, time);
    } else if (
      p.type === "function_call_output" ||
      p.type === "custom_tool_call_output" ||
      p.type === "local_shell_call_output"
    )
      this.result(String(p.call_id), codexOutput(p.output));
  }

  private claudeEntry(entry: Record<string, any>) {
    const kind = entry["type"],
      time = stamp(entry["timestamp"]),
      content = entry["message"]?.content;
    if (entry["isSidechain"]) return;
    if (kind === "user" && typeof content === "string") {
      if (entry["isMeta"] && content.startsWith("<local-command-caveat>")) {
        this.localPrompts.add(entry["promptId"]);
        return;
      }
      const local =
        localCommand(content) ??
        // A message typed while a command runs can get the command's promptId.
        (!entry["isMeta"] &&
        entry["origin"]?.kind !== "human" &&
        entry["promptId"] &&
        this.localPrompts.has(entry["promptId"])
          ? { output: content }
          : undefined);
      if (local) {
        const text = clean(local.output.replace(/`/g, "").trim(), 300);
        if (local.command !== undefined)
          this.push(
            (this.localNote = {
              id: String(entry["uuid"] ?? this.count),
              role: "note",
              text: [local.command, text].filter(Boolean).join(": "),
              time,
            }),
          );
        else if (this.localNote && this.out.at(-1) === this.localNote) {
          if (text) {
            this.localNote.text += ": " + text;
            this.changed.add(this.localNote);
          }
        } else if (text)
          this.push({
            id: String(entry["uuid"] ?? this.count),
            role: "note",
            text,
            time,
          });
        return;
      }
    }
    if (kind === "user") {
      // Claude Code reports finished background tasks as a user turn.
      if (entry["origin"]?.kind === "task-notification") {
        const summary = plainText(content).match(
          /<summary>([\s\S]*?)<\/summary>/,
        )?.[1];
        if (summary?.trim())
          this.push({
            id: String(entry["uuid"] ?? this.count),
            role: "note",
            text: clean(summary.trim(), 300),
            time,
          });
        return;
      }
      if (entry["isCompactSummary"]) {
        this.push({
          id: String(entry["uuid"] ?? this.count),
          role: "note",
          text: "Conversation compacted",
          time,
        });
        return;
      }
      for (const b of Array.isArray(content) ? content : [])
        if (b?.type === "tool_result")
          this.result(
            String(b.tool_use_id),
            resultText(b.content),
            !!b.is_error,
          );
      const text = stripPasteTags(stripReminders(plainText(content))).trim(),
        pics = images(content);
      if ((text || pics.length) && !entry["isMeta"] && !startsWithSkipped(text))
        this.push({
          id: String(entry["uuid"] ?? this.count),
          role: "user",
          text: clean(text),
          time,
          images: pics.length ? pics : undefined,
        });
    } else if (kind === "attachment") {
      // A message typed while Claude works is delivered as an attachment.
      const a = entry["attachment"],
        text = stripPasteTags(stripReminders(plainText(a?.prompt))).trim();
      if (a?.type === "queued_command" && a.origin?.kind === "human" && text)
        this.push({
          id: String(entry["uuid"] ?? a.source_uuid ?? this.count),
          role: "user",
          text: clean(text),
          time,
        });
    } else if (kind === "assistant") {
      (Array.isArray(content) ? content : []).forEach((b: any, i: number) => {
        if (b?.type === "text" && String(b.text ?? "").trim())
          this.push({
            id: `${entry["uuid"] ?? this.count}:${i}`,
            role: "assistant",
            text: clean(String(b.text).trim()),
            time,
          });
        if (b?.type !== "tool_use") return;
        const asked =
          b.name === "Bash" && typeof b.input?.command === "string"
            ? askCommand(b.input.command, true)
            : undefined;
        if (asked) this.ask(String(b.id), asked, time);
        else
          this.tool(
            String(b.id),
            String(b.name ?? "tool"),
            toolArg(b.input),
            pretty(b.input),
            time,
          );
      });
    }
  }
}

export interface ChatView {
  messages: ChatMessage[];
  omitted: number;
}

/** Follows one transcript: each update reads only the bytes appended since the last. */
export class ConversationReader {
  private parser?: Parser;
  private ino = -1;
  /** Bytes fully read; `pending` holds a line that is not finished yet. */
  private offset = 0;
  private pending = Buffer.alloc(0);
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }

  /** "reset" when the file was replaced or cut short; otherwise the new or changed
   *  messages that are still in view. */
  update(): "reset" | ChatView {
    const st = statSync(this.path);
    let reset = false;
    if (st.ino !== this.ino || st.size < this.offset + this.pending.length) {
      reset = this.ino !== -1;
      this.ino = st.ino;
      this.parser = undefined;
      this.offset = 0;
      this.pending = Buffer.alloc(0);
    }
    let at = this.offset + this.pending.length;
    // An open chat checks every second; most checks find nothing new.
    if (at < st.size) {
      const fd = openSync(this.path, "r");
      try {
        const chunk = Buffer.allocUnsafe(Math.min(4 * 1024 * 1024, st.size - at));
        while (at < st.size) {
          const n = readSync(
            fd,
            chunk,
            0,
            Math.min(chunk.length, st.size - at),
            at,
          );
          if (!n) break;
          at += n;
          this.lines(Buffer.concat([this.pending, chunk.subarray(0, n)]));
          this.parser?.trim();
        }
      } finally {
        closeSync(fd);
      }
    }
    // A last line without its newline still counts once it is complete JSON, as in
    // a full read. A later newline then only adds an empty line.
    if (this.pending.length && this.record(this.pending.toString("utf8"))) {
      this.offset += this.pending.length;
      this.pending = Buffer.alloc(0);
    }
    const p = this.parser;
    if (!p) return reset ? "reset" : { messages: [], omitted: 0 };
    const changed = p.changed;
    p.changed = new Set();
    return reset ? "reset" : this.view(changed);
  }

  /** The newest messages, with images up to the response budget. */
  view(only?: Set<ChatMessage>): ChatView {
    const p = this.parser;
    if (!p) return { messages: [], omitted: 0 };
    const shown = p.out.slice(-MAX_MESSAGES),
      messages = only ? shown.filter((m) => only.has(m)) : shown;
    // Newest images first, until the response budget is used.
    let budget = MAX_IMAGE_CHARS;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (!m.images) continue;
      const keep = m.images.filter((url) => (budget -= url.length) >= 0),
        dropped = m.images.length - keep.length;
      if (dropped)
        messages[i] = {
          ...m,
          images: keep.length ? keep : undefined,
          text: [
            m.text,
            `[${dropped} image${dropped > 1 ? "s" : ""} not shown]`,
          ]
            .filter(Boolean)
            .join("\n"),
        };
    }
    return {
      messages,
      omitted: p.dropped + Math.max(0, p.out.length - MAX_MESSAGES),
    };
  }

  private lines(data: Buffer) {
    let start = 0,
      end: number;
    while ((end = data.indexOf(10, start)) >= 0) {
      this.record(data.subarray(start, end).toString("utf8"));
      this.offset += end + 1 - start;
      start = end + 1;
    }
    this.pending = Buffer.from(data.subarray(start));
  }

  /** Same rules as entries(): blank and broken lines are skipped. */
  private record(line: string): boolean {
    if (!line.trim()) return false;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return false;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return false;
    // detectSource() reads the first 400 characters of the file.
    this.parser ??= new Parser(line.slice(0, 400).includes('"session_meta"'));
    this.parser.handle(entry as Record<string, any>);
    return true;
  }
}

export function readConversation(path: string): ChatView {
  const reader = new ConversationReader(path);
  reader.update();
  return reader.view();
}
