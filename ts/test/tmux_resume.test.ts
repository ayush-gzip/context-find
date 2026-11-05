import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentWorkspace } from "../src/agents.ts";
import { createWebServer } from "../src/web.ts";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

/** A scratch tmux server and fake Claude and Codex that record how they started. */
function scratch(name: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `cfind-${name}-`))),
    socket = `cfind-${name}-${process.pid}`,
    prior = {
      CFIND_CLAUDE_BIN: process.env.CFIND_CLAUDE_BIN,
      CFIND_CODEX_BIN: process.env.CFIND_CODEX_BIN,
      CFIND_TMUX_BIN: process.env.CFIND_TMUX_BIN,
    };
  writeFileSync(join(dir, "tmux"), `#!/bin/sh\nexec tmux -L ${socket} "$@"\n`, {
    mode: 0o700,
  });
  for (const tool of ["claude", "codex"])
    writeFileSync(
      join(dir, tool),
      `#!/usr/bin/env node
const args=process.argv.slice(2),sid=args[args.indexOf('${tool === "codex" ? "resume" : "--resume"}')+1];
require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(dir)},'${tool}-'+sid+'.json'),JSON.stringify({args,cwd:process.cwd(),config:process.env.CLAUDE_CONFIG_DIR??null,nested:process.env.CLAUDECODE??null}));
if(sid==='dies')process.exit(1);
setInterval(()=>{},1000);`,
      { mode: 0o700 },
    );
  process.env.CFIND_TMUX_BIN = join(dir, "tmux");
  process.env.CFIND_CLAUDE_BIN = join(dir, "claude");
  process.env.CFIND_CODEX_BIN = join(dir, "codex");
  const sessions = () => {
    const out: Record<string, number> = {};
    for (const s of execFileSync(join(dir, "tmux"), ["list-windows", "-a", "-F", "#{session_name}"])
      .toString()
      .trim()
      .split("\n"))
      out[s] = (out[s] ?? 0) + 1;
    return out;
  };
  const started = async (file: string) => {
    const end = Date.now() + 5000;
    while (!existsSync(join(dir, file))) {
      if (Date.now() > end) throw new Error(`${file} was not written`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return JSON.parse(readFileSync(join(dir, file), "utf8"));
  };
  const close = () => {
    spawnSync("tmux", ["-L", socket, "kill-server"]);
    // tmux leaves the socket file behind when its server is killed.
    rmSync(join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid!()}`, socket), {
      force: true,
    });
    for (const [k, v] of Object.entries(prior))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, sessions, started, close };
}

test(
  "a closed session resumes in tmux with the message, five windows per tmux session",
  { skip: !hasTmux && "tmux is not installed" },
  async () => {
    const t = scratch("resume"),
      { dir } = t,
      prompts = () => readdirSync(tmpdir()).filter((n) => n.startsWith("cfind-prompt-")).length,
      before = prompts(),
      w = new AgentWorkspace(
        [
          {
            id: "personal",
            source: "claude",
            label: "Claude",
            path: join(dir, ".claude-personal", "projects"),
          },
          { id: "codex", source: "codex", label: "Codex", path: join(dir, "x") },
        ],
        join(dir, "data"),
      );
    mkdirSync(join(dir, "data"));
    try {
      // Quotes and $(...) stay text; the length is past tmux's 16 KB command limit.
      const message = `it's "quoted" $(touch ${join(dir, "pwned")}) \`id\`\nnext line ` + "x".repeat(50000);
      const r = w.resumeInTerminal("personal", dir, "sid-1", message);
      assert.match(r.pane, /^%\d+$/);
      assert.deepEqual(await t.started("claude-sid-1.json"), {
        args: ["--resume", "sid-1", message],
        cwd: dir,
        config: join(dir, ".claude-personal"),
        nested: null,
      });
      assert.ok(!existsSync(join(dir, "pwned")));
      assert.equal(prompts(), before);

      w.resumeInTerminal("codex", dir, "thread-1", "hi");
      assert.deepEqual((await t.started("codex-thread-1.json")).args, ["resume", "thread-1", "hi"]);

      for (let i = 2; i <= 6; i++) w.resumeInTerminal("personal", dir, `sid-${i}`, "hi");
      assert.deepEqual(t.sessions(), { cfind: 5, "cfind-2": 2 });
      // A batch with no windows left is made again before a new one is added.
      execFileSync(join(dir, "tmux"), ["kill-session", "-t", "cfind"]);
      w.resumeInTerminal("personal", dir, "sid-7", "hi");
      assert.deepEqual(t.sessions(), { cfind: 1, "cfind-2": 2 });
    } finally {
      w.close();
      t.close();
    }
  },
);

test(
  "the dashboard resumes a closed session in tmux once, and reports a terminal that closes",
  { skip: !hasTmux && "tmux is not installed" },
  async () => {
    const t = scratch("api"),
      { dir } = t,
      prior = {
        HOME: process.env.HOME,
        CFIND_DATA_DIR: process.env.CFIND_DATA_DIR,
        CODEX_HOME: process.env.CODEX_HOME,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      };
    process.env.HOME = dir;
    process.env.CFIND_DATA_DIR = join(dir, "metrics");
    process.env.CODEX_HOME = join(dir, "codex-home");
    delete process.env.CLAUDE_CONFIG_DIR;
    const root = join(dir, ".claude", "projects", "project");
    mkdirSync(root, { recursive: true });
    for (const sid of ["s", "dies"])
      writeFileSync(
        join(root, `${sid}.jsonl`),
        JSON.stringify({
          type: "user",
          timestamp: "2026-10-27T12:00:00Z",
          sessionId: sid,
          cwd: dir,
          message: { role: "user", content: "earlier" },
        }) + "\n",
      );
    const { server, token } = createWebServer([]);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const base = `http://127.0.0.1:${(server.address() as any).port}`,
        send = async (sid: string) => {
          const r = await fetch(`${base}/api/agent?t=${token}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "create", profile: "claude", cwd: dir, sid, prompt: "go on" }),
          });
          return { status: r.status, body: await r.json() };
        };
      const sessions = (await (await fetch(`${base}/api/metrics?t=${token}`)).json()).sessions;
      assert.ok(sessions.some((s: any) => s.id === "s" && !s.open));

      assert.deepEqual(await send("s"), {
        status: 200,
        body: { terminal: true, queued: true, profile: "claude", sid: "s" },
      });
      assert.deepEqual((await t.started("claude-s.json")).args, ["--resume", "s", "go on"]);
      // The phone and the Mac must not start it twice.
      const again = await send("s");
      assert.notEqual(again.status, 200);
      assert.match(again.body.error, /open in a terminal/);
      assert.deepEqual(t.sessions(), { cfind: 1 });

      const dies = await send("dies");
      assert.notEqual(dies.status, 200);
      assert.match(dies.body.error, /closed right away/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      for (const [k, v] of Object.entries(prior))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      t.close();
    }
  },
);
