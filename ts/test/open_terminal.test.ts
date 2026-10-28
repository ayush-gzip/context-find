import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentWorkspace, newAgent } from "../src/agents.ts";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

test(
  "Open in terminal moves an idle Claude agent to a tmux window",
  { skip: !hasTmux && "tmux is not installed" },
  async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "cfind-term-"))),
      socket = "cfind-test-" + process.pid,
      prior = {
        CFIND_CLAUDE_BIN: process.env.CFIND_CLAUDE_BIN,
        CFIND_TMUX_BIN: process.env.CFIND_TMUX_BIN,
      };
    // A scratch tmux server: the test never touches the default one.
    writeFileSync(
      join(dir, "tmux"),
      `#!/bin/sh\nexec tmux -L ${socket} "$@"\n`,
      { mode: 0o700 },
    );
    // Print mode answers like Claude; the terminal run records how it started.
    writeFileSync(
      join(dir, "claude"),
      `#!/usr/bin/env node
const args=process.argv.slice(2),fs=require('node:fs'),path=require('node:path');
if(!args.includes('-p')){
 fs.writeFileSync(path.join(${JSON.stringify(dir)},'terminal-'+args[1]+'.json'),JSON.stringify({args,cwd:process.cwd(),config:process.env.CLAUDE_CONFIG_DIR??null,nested:process.env.CLAUDECODE??null}));
 setInterval(()=>{},1000);
} else {
 const send=o=>console.log(JSON.stringify(o));
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);if(m.type!=='user')return;
  send({type:'system',subtype:'init',session_id:'sid-'+process.pid,model:'opus'});
  setTimeout(()=>send({type:'result',subtype:'success',result:'done'}),m.message.content.includes('slow')?3000:10);
 });
}`,
      { mode: 0o700 },
    );
    process.env.CFIND_TMUX_BIN = join(dir, "tmux");
    process.env.CFIND_CLAUDE_BIN = join(dir, "claude");
    const data = join(dir, "data"),
      codex = newAgent("codex", dir, "codex agent"),
      fresh = newAgent("personal", dir, "no session");
    codex.sid = "thread";
    mkdirSync(data);
    writeFileSync(join(data, "workspace.json"), JSON.stringify([codex, fresh]));
    const w = new AgentWorkspace(
      [
        {
          id: "personal",
          source: "claude",
          label: "Claude",
          path: join(dir, ".claude-personal", "projects"),
        },
        { id: "codex", source: "codex", label: "Codex", path: join(dir, "x") },
      ],
      data,
    );
    const until = async (check: () => boolean) => {
      const end = Date.now() + 5000;
      while (!check()) {
        if (Date.now() > end) throw new Error("Condition timed out");
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    try {
      await assert.rejects(w.openInTerminal(codex.id), /Only Claude agents/);
      await assert.rejects(w.openInTerminal(fresh.id), /no session yet/);

      const a = await w.create("personal", dir, "hi");
      await until(() => a.state === "idle" && !!a.sid);
      const headless = (w as any).claude.get(a.id);
      const t = await w.openInTerminal(a.id);
      assert.equal(t.sid, a.sid);
      assert.match(t.pane, /^%\d+$/);
      assert.ok(headless.exitCode !== null || headless.signalCode !== null);
      assert.ok(!w.snapshot().agents.some((x) => x.id === a.id));
      const file = join(dir, `terminal-${a.sid}.json`);
      await until(() => existsSync(file));
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
        args: ["--resume", a.sid, "--permission-mode", "auto"],
        cwd: dir,
        config: join(dir, ".claude-personal"),
        nested: null,
      });

      // The tmux session exists now, so the next agent gets a new window.
      const b = await w.create("personal", dir, "hi");
      await until(() => b.state === "idle" && !!b.sid);
      // Without a running print-mode process.
      (w as any).claude.get(b.id).kill();
      await until(() => !(w as any).claude.has(b.id));
      b.state = "idle";
      b.permissionMode = "manual";
      await w.openInTerminal(b.id);
      await until(() => existsSync(join(dir, `terminal-${b.sid}.json`)));
      assert.deepEqual(
        JSON.parse(readFileSync(join(dir, `terminal-${b.sid}.json`), "utf8")).args,
        ["--resume", b.sid, "--permission-mode", "manual"],
      );
      const windows = execFileSync(join(dir, "tmux"), [
        "list-windows",
        "-t",
        "cfind",
        "-F",
        "#{pane_id}",
      ])
        .toString()
        .trim()
        .split("\n");
      assert.equal(windows.length, 2);

      const c = await w.create("personal", dir, "slow");
      await until(() => c.state === "running");
      await assert.rejects(w.openInTerminal(c.id), /Wait for the reply to finish/);
    } finally {
      w.close();
      spawnSync("tmux", ["-L", socket, "kill-server"]);
      // tmux leaves the socket file behind when its server is killed.
      rmSync(join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid!()}`, socket), { force: true });
      for (const [k, v] of Object.entries(prior))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
