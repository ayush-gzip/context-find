import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { monitorDir } from "./monitor.ts";
import { quoteForPosixShell } from "./remote.ts";

export function recordSignal(
  profile: string,
  input: any,
  dataDir = monitorDir(),
  kind = "hook",
) {
  if (!input || typeof input !== "object") return;
  const sessionId = input.session_id;
  if (typeof sessionId !== "string") return;
  const event = input.hook_event_name || "statusline";
  const states: Record<string, string> = {
    SessionStart: "idle",
    UserPromptSubmit: "running",
    PreToolUse: "running",
    PostToolUse: "running",
    PermissionRequest: "waiting",
    Notification: "waiting",
    Stop: "idle",
    SessionEnd: "stopped",
    SubagentStart: "running",
    SubagentStop: "complete",
  };
  const signal = {
    kind,
    profile,
    sessionId,
    agentId: input.agent_id,
    agentType: input.agent_type,
    event,
    cwd: input.cwd ?? input.workspace?.current_dir,
    model: input.model?.display_name ?? input.model?.id,
    state: states[event] ?? "unknown",
    updatedAt: Date.now(),
    ...(kind === "statusline"
      ? {
          rate_limits: input.rate_limits,
          cost: input.cost,
          context_window: input.context_window,
        }
      : {}),
  };
  const dir = join(dataDir, "signals");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = createHash("sha256")
    .update(`${profile}|${sessionId}|${input.agent_id ?? ""}|${kind}`)
    .digest("hex");
  const path = join(dir, key + ".json"),
    temp = path + `.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(signal), { mode: 0o600 });
  renameSync(temp, path);
}

export function installClaudeProfile(
  configDir: string,
  profile: string,
  dataDir = monitorDir(),
) {
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, "settings.json");
  const original = existsSync(path) ? readFileSync(path, "utf8") : "{}";
  const settings = JSON.parse(original);
  if (!existsSync(path + ".cfind-backup"))
    writeFileSync(path + ".cfind-backup", original, { mode: 0o600 });
  const script = fileURLToPath(import.meta.url).replace(/\.ts$/, ".js");
  const command = `${quoteForPosixShell(process.execPath)} ${quoteForPosixShell(script)}`;
  const args = ` ${quoteForPosixShell(profile)} ${quoteForPosixShell(dataDir)}`;
  const originalStatus = settings.statusLine?.command;
  if (!originalStatus?.includes(`${script}' statusline`)) {
    const encoded = Buffer.from(originalStatus || "").toString("base64");
    settings.statusLine = {
      ...settings.statusLine,
      type: "command",
      command:
        command + " statusline" + args + " " + quoteForPosixShell(encoded),
    };
  }
  settings.hooks ??= {};
  for (const event of [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Stop",
    "SubagentStart",
    "SubagentStop",
  ]) {
    const entries = (settings.hooks[event] ??= []);
    if (
      !entries.some((e: any) =>
        e.hooks?.some((h: any) => h.command?.includes(script)),
      )
    )
      entries.push({
        hooks: [
          {
            type: "command",
            command: command + " hook" + args,
            timeout: 5,
            async: true,
          },
        ],
      });
  }
  const temp = path + ".cfind-tmp";
  writeFileSync(temp, JSON.stringify(settings, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(temp, path);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [mode, profile, dataDir, encoded] = process.argv.slice(2);
  const input = readFileSync(0, "utf8");
  try {
    recordSignal(
      profile!,
      JSON.parse(input),
      dataDir,
      mode === "statusline" ? "statusline" : "hook",
    );
  } catch {}
  if (mode === "statusline" && encoded) {
    const command = Buffer.from(encoded, "base64").toString("utf8");
    if (command) {
      const result = spawnSync(command, {
        shell: true,
        input,
        encoding: "utf8",
        timeout: 4000,
        maxBuffer: 1024 * 1024,
      });
      if (result.stdout) process.stdout.write(result.stdout);
    }
  }
}
