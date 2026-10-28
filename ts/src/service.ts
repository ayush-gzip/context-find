import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dashboardProfiles, monitorDir } from "./monitor.ts";
import { installClaudeProfile } from "./collector.ts";

export function serviceState(): {
  pid: number;
  port: number;
  token: string;
} | null {
  try {
    const state = JSON.parse(
      readFileSync(join(monitorDir(), "service.json"), "utf8"),
    );
    if (
      !Number.isInteger(state.pid) ||
      state.pid <= 0 ||
      !Number.isInteger(state.port) ||
      typeof state.token !== "string"
    )
      return null;
    try {
      process.kill(state.pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EPERM") return null;
    }
    return state;
  } catch {
    return null;
  }
}
const xml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
const label = "com.context-find.dashboard";
const plist = () =>
  join(homedir(), "Library", "LaunchAgents", label + ".plist");
export async function serviceCommand(
  action: string,
  port: number,
  run: () => Promise<number>,
): Promise<number> {
  const dir = monitorDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = serviceState();
  if (action === "status") {
    console.log(
      existing
        ? `running (PID ${existing.pid}) · http://127.0.0.1:${existing.port}/`
        : "stopped",
    );
    return existing ? 0 : 1;
  }
  if (action === "run") {
    if (existing && existing.pid !== process.pid) {
      console.log(`Already running on port ${existing.port}`);
      return 0;
    }
    return run();
  }
  if (action === "stop") {
    if (process.platform === "darwin" && existsSync(plist()))
      spawnSync(
        "launchctl",
        ["bootout", `gui/${process.getuid?.()}`, plist()],
        { stdio: "ignore" },
      );
    if (existing)
      try {
        process.kill(existing.pid, "SIGTERM");
      } catch {}
    rmSync(join(dir, "service.json"), { force: true });
    console.log("Dashboard service stopped.");
    return 0;
  }
  if (action === "install") {
    for (const p of dashboardProfiles().filter((p) => p.source === "claude"))
      installClaudeProfile(dirname(p.path), p.id, dir);
    if (process.platform === "darwin") {
      const path = plist();
      mkdirSync(dirname(path), { recursive: true });
      const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
      const args = [
        process.execPath,
        cli,
        "service",
        "run",
        "--port",
        String(port),
      ];
      writeFileSync(
        path,
        `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin")}</string>${process.env["CODEX_HOME"] ? `<key>CODEX_HOME</key><string>${xml(process.env["CODEX_HOME"])}</string>` : ""}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(join(dir, "service.log"))}</string><key>StandardErrorPath</key><string>${xml(join(dir, "service.log"))}</string></dict></plist>\n`,
        { mode: 0o600 },
      );
      if (existing) {
        try {
          process.kill(existing.pid, "SIGTERM");
        } catch {}
        for (let i = 0; i < 30 && serviceState(); i++)
          await new Promise((r) => setTimeout(r, 100));
      }
      spawnSync("launchctl", ["bootout", `gui/${process.getuid?.()}`, path], {
        stdio: "ignore",
      });
      const result = spawnSync(
        "launchctl",
        ["bootstrap", `gui/${process.getuid?.()}`, path],
        { encoding: "utf8" },
      );
      if (result.status !== 0)
        throw new Error(result.stderr || "Could not install LaunchAgent");
      console.log("Claude collectors and login startup installed.");
      return 0;
    }
    console.log(
      "Claude collectors installed. Login startup is available on macOS.",
    );
  }
  if (action === "start" || action === "install") {
    if (existing) {
      console.log(`Already running on port ${existing.port}`);
      return 0;
    }
    // After `stop` booted the LaunchAgent out, start it through launchd again so
    // it keeps restarting after a crash or a reboot.
    if (process.platform === "darwin" && existsSync(plist())) {
      const result = spawnSync(
        "launchctl",
        ["bootstrap", `gui/${process.getuid?.()}`, plist()],
        { encoding: "utf8" },
      );
      // Exit 5 (already loaded) still means launchd supervises it.
      if (result.status === 0 || result.status === 5) {
        spawnSync(
          "launchctl",
          ["kickstart", `gui/${process.getuid?.()}/${label}`],
          { stdio: "ignore" },
        );
        console.log(`Dashboard service starting on http://127.0.0.1:${port}/`);
        return 0;
      }
    }
    const log = openSync(join(dir, "service.log"), "a", 0o600);
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./cli.js", import.meta.url)),
        "service",
        "run",
        "--port",
        String(port),
      ],
      { detached: true, stdio: ["ignore", log, log], env: process.env },
    );
    child.unref();
    closeSync(log);
    console.log(`Dashboard service starting on http://127.0.0.1:${port}/`);
    return 0;
  }
  throw new Error("Usage: cfind service start|stop|status|install");
}
