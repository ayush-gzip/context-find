// "Needs your answer": a turn ended and the agent waits for the user. The agent
// says so by running `cfind ask "<question>"` as its last step. When it forgets,
// the last paragraph of its final reply can still show it.

const MAX = 240;
const clip = (text: string) => {
  const t = text
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > MAX ? t.slice(0, MAX - 1) + "…" : t;
};

/** The words after `cfind ask`: the quoted question, or the rest of the line. */
function question(rest: string) {
  // Inside a Codex exec script the command is a JS string, so its quotes are escaped.
  const r = rest.replace(/\\(["'])/g, "$1").trim();
  const quoted = /^(["'])([\s\S]*?)\1/.exec(r);
  return (
    clip(quoted ? quoted[2]! : r.split(/[\n;&|"'`]/)[0]!) ||
    "Waiting for your answer"
  );
}

/** The question when a shell command is the `cfind ask` call itself. Codex runs
 *  commands as `zsh -lc '…'`. A command that only mentions it does not count. */
export function askCommand(command: string): string | undefined {
  let c = command.trim();
  const shell = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(["'])([\s\S]*)\1$/.exec(c);
  if (shell) c = shell[2]!.trim();
  const m = /^cfind\s+ask\b([\s\S]*)$/.exec(c);
  return m ? question(m[1]!) : undefined;
}

/** The same call in a Codex exec script: `tools.exec_command({cmd:"cfind ask \"…\""})`. */
export function askScript(script: string): string | undefined {
  const m = /\bcmd["']?\s*:\s*["'`]\s*cfind\s+ask\b([^\n]*)/.exec(script);
  return m ? question(m[1]!) : undefined;
}

const ASKING = [
  /\?[)*_"'”\s]*$/,
  /\b(needs?|waiting (for|on)|awaiting) your\b/i,
  /\b(should|shall) I\b/i,
  /\b(do|would) you (want|like|prefer)\b/i,
  /\bwant me to\b/i,
  /\bwhich (one|option|of (these|them|the))\b/i,
  /\byour (call|go|go-ahead|decision|answer|approval|confirmation|input)\b/i,
  /\b(please|can you|could you) confirm\b/i,
  /\blet me know (which|whether|what|how)\b/i,
];

/** The asking part of a final reply, when its last paragraph asks the user something. */
export function askReply(reply: string | undefined): string | undefined {
  const text = reply?.replace(/```[\s\S]*?```/g, "").trim();
  const last = text?.split(/\n\s*\n/).at(-1)?.trim();
  if (!last || !ASKING.some((r) => r.test(last))) return;
  if (last.length <= MAX) return clip(last);
  const sentences = last.split(/(?<=[.!?])\s+/);
  return clip(
    [...sentences].reverse().find((s) => ASKING.some((r) => r.test(s))) ??
      sentences.at(-1)!,
  );
}
