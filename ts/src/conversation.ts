/** Structured local transcripts for the dashboard chat view. Remote sessions keep
 *  the line renderer, because store.py is the copy that runs on remote machines. */
import {
  codexText,
  detectSource,
  entries,
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
}

const MAX_MESSAGES = 400,
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

export function readConversation(path: string): {
  messages: ChatMessage[];
  omitted: number;
} {
  const out: ChatMessage[] = [],
    tools = new Map<string, ChatMessage>();
  const tool = (
    id: string,
    name: string,
    summary: string,
    input: string,
    time?: number,
  ) => {
    const m: ChatMessage = {
      id,
      role: "tool",
      text: clean(summary.split(/\s+/).join(" "), 300),
      time,
      tool: { name: clean(name, 200), input: clean(input, MAX_TOOL_TEXT) },
    };
    tools.set(id, m);
    out.push(m);
  };
  const result = (id: string, output: string, error = false) => {
    const m = tools.get(id);
    if (m?.tool) {
      m.tool.output = clean(output, MAX_TOOL_TEXT);
      m.tool.error = error || undefined;
    }
  };

  if (detectSource(path) === "codex") {
    for (const entry of entries(path)) {
      const p = entry["payload"] ?? {},
        time = stamp(entry["timestamp"]);
      if (entry["type"] !== "response_item") continue;
      const id = String(p.id ?? p.call_id ?? out.length);
      if (p.type === "message") {
        const text = codexText(p).trim(),
          pics = p.role === "user" ? images(p.content) : [];
        if (!text && !pics.length) continue;
        if (p.role === "user" && !startsWithCodexSkipped(text))
          out.push({
            id,
            role: "user",
            text: clean(text),
            time,
            images: pics.length ? pics : undefined,
          });
        if (p.role === "assistant")
          out.push({ id, role: "assistant", text: clean(text), time });
      } else if (p.type === "function_call" || p.type === "custom_tool_call") {
        const raw = String(p.arguments ?? p.input ?? "");
        tool(
          String(p.call_id ?? id),
          String(p.name ?? "tool"),
          codexSummary(raw),
          pretty(raw),
          time,
        );
      } else if (p.type === "local_shell_call") {
        const command = [p.action?.command ?? []].flat().join(" ");
        tool(String(p.call_id ?? id), "shell", command, command, time);
      } else if (
        p.type === "function_call_output" ||
        p.type === "custom_tool_call_output" ||
        p.type === "local_shell_call_output"
      )
        result(String(p.call_id), codexOutput(p.output));
    }
  } else {
    for (const entry of entries(path)) {
      const kind = entry["type"],
        time = stamp(entry["timestamp"]),
        content = entry["message"]?.content;
      if (entry["isSidechain"]) continue;
      if (kind === "user") {
        // Claude Code reports finished background tasks as a user turn.
        if (entry["origin"]?.kind === "task-notification") {
          const summary = plainText(content).match(
            /<summary>([\s\S]*?)<\/summary>/,
          )?.[1];
          if (summary?.trim())
            out.push({
              id: String(entry["uuid"] ?? out.length),
              role: "note",
              text: clean(summary.trim(), 300),
              time,
            });
          continue;
        }
        if (entry["isCompactSummary"]) {
          out.push({
            id: String(entry["uuid"] ?? out.length),
            role: "note",
            text: "Conversation compacted",
            time,
          });
          continue;
        }
        for (const b of Array.isArray(content) ? content : [])
          if (b?.type === "tool_result")
            result(String(b.tool_use_id), resultText(b.content), !!b.is_error);
        const text = stripPasteTags(stripReminders(plainText(content))).trim(),
          pics = images(content);
        if (
          (text || pics.length) &&
          !entry["isMeta"] &&
          !startsWithSkipped(text)
        )
          out.push({
            id: String(entry["uuid"] ?? out.length),
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
          out.push({
            id: String(entry["uuid"] ?? a.source_uuid ?? out.length),
            role: "user",
            text: clean(text),
            time,
          });
      } else if (kind === "assistant") {
        (Array.isArray(content) ? content : []).forEach((b: any, i: number) => {
          if (b?.type === "text" && String(b.text ?? "").trim())
            out.push({
              id: `${entry["uuid"] ?? out.length}:${i}`,
              role: "assistant",
              text: clean(String(b.text).trim()),
              time,
            });
          if (b?.type === "tool_use")
            tool(
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
  const messages = out.slice(-MAX_MESSAGES);
  // Newest images first, until the response budget is used.
  let budget = MAX_IMAGE_CHARS;
  for (const m of [...messages].reverse()) {
    if (!m.images) continue;
    const keep = m.images.filter((url) => (budget -= url.length) >= 0),
      dropped = m.images.length - keep.length;
    m.images = keep.length ? keep : undefined;
    if (dropped)
      m.text = [m.text, `[${dropped} image${dropped > 1 ? "s" : ""} not shown]`]
        .filter(Boolean)
        .join("\n");
  }
  return { messages, omitted: Math.max(0, out.length - MAX_MESSAGES) };
}
