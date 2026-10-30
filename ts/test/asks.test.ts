import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askCommand, askReply, askScript } from "../src/asks.ts";
import { Monitor } from "../src/monitor.ts";
import { AgentWorkspace } from "../src/agents.ts";

test("cfind ask calls are found in commands and Codex exec scripts", () => {
  assert.equal(askCommand(`cfind ask "Go with option C?"`), "Go with option C?");
  assert.equal(askCommand(`  cfind ask 'Which region?'`), "Which region?");
  assert.equal(askCommand(`/bin/zsh -lc 'cfind ask "Ship it?"'`), "Ship it?");
  assert.equal(askCommand(`cfind ask`), "Waiting for your answer");
  // Only the call itself counts, not a command that mentions it.
  assert.equal(askCommand(`grep -n "cfind ask" src/asks.ts`), undefined);
  assert.equal(askCommand(`echo hi && cfind ask "x"`), undefined);
  assert.equal(
    askScript(`text(await tools.exec_command({cmd:"cfind ask \\"Pick A or B?\\""}))`),
    "Pick A or B?",
  );
  assert.equal(
    askScript(`text(await tools.exec_command({cmd:"rg -n 'cfind ask' src"}))`),
    undefined,
  );
});

test("a final reply asks when its last paragraph does", () => {
  const asks = [
    "Tests pass.\n\nNext (needs your go): option C. Then I re-run S10. Go?",
    "Done.\n\nShould I also update the docs",
    "Two ways to fix it.\n\nWhich option do you prefer, A or B.",
    "It is ready.\n\nWant me to open the PR",
    "Built.\n\nYour call: ship tonight or tomorrow.",
    "Done.\n\n**Do you want me to deploy?**",
  ];
  for (const r of asks) assert.ok(askReply(r), r);
  const plain = [
    "Done. Tests pass.",
    "Why did it fail? The token expired.\n\nI renewed it and the run passed.",
    "Fixed.\n\n```sh\nread -p 'Continue?'\n```",
    "",
    // Quoted: a label or someone else's words.
    'Fixed.\n\n- The card now shows "Needs your answer" while a shell runs.\n- Tests pass.',
    'Done.\n\nThe log said "Should I go on?" twice, and `want me to` is a pattern.',
  ];
  for (const r of plain) assert.equal(askReply(r), undefined, r);
  assert.equal(askReply("Done.\n\nGo with **C**?"), "Go with C?");
  assert.equal(askReply('Done.\n\nShould I name it "fast"?'), 'Should I name it "fast"?');
  const long = "x ".repeat(200) + "Then it is done. Ship it?";
  assert.equal(askReply(long), "Ship it?");
});

const at = "2026-10-28T10:00:00Z";
const user = (sid: string, content: unknown) => ({
  type: "user",
  timestamp: at,
  sessionId: sid,
  cwd: "/p",
  message: { role: "user", content },
});
const said = (sid: string, ...content: unknown[]) => ({
  type: "assistant",
  timestamp: at,
  sessionId: sid,
  cwd: "/p",
  message: { id: "m" + Math.random(), role: "assistant", content },
});
const text = (t: string) => ({ type: "text", text: t });
const bash = (command: string) => ({
  type: "tool_use",
  id: "t" + Math.random(),
  name: "Bash",
  input: { command },
});
const lines = (...rows: unknown[]) =>
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

test("sessions show the question once the turn ends, until the user answers", async () => {
  const home = mkdtempSync(join(tmpdir(), "cfind-asks-"));
  const roots = [
    { id: "claude", label: "Claude", source: "claude" as const, path: join(home, "claude") },
    { id: "codex", label: "Codex", source: "codex" as const, path: join(home, "codex") },
  ];
  roots.forEach((r) => mkdirSync(r.path));
  const claude = (sid: string, ...rows: unknown[]) =>
    writeFileSync(join(roots[0]!.path, sid + ".jsonl"), lines(...rows));
  try {
    claude(
      "explicit",
      user("explicit", "fix it"),
      said("explicit", text("Looking."), bash(`cfind ask "Go with C?"`)),
      user("explicit", [{ type: "tool_result", tool_use_id: "x", content: "ok" }]),
      said("explicit", text("Plan below. Option C is safest.")),
    );
    claude("pattern", user("pattern", "check"), said("pattern", text("Found it.\n\nThen I re-run S10. Go?")));
    claude("plain", user("plain", "check"), said("plain", text("Why? The token expired.\n\nRenewed; it passed.")));
    claude(
      "answered",
      user("answered", "fix it"),
      said("answered", bash(`cfind ask "Go?"`), text("Go?")),
      user("answered", "yes"),
      said("answered", text("Done.")),
    );
    claude("busy", user("busy", "check"), said("busy", text("Should I go on?")));
    // The turn ended, but a background shell still runs.
    claude("shellask", user("shellask", "check"), said("shellask", text("Done.\n\nYour call: ship it?")));
    claude("shellplain", user("shellplain", "check"), said("shellplain", text("Started the build.")));
    const status: Record<string, string> = { busy: "busy", shellask: "shell", shellplain: "shell" };
    mkdirSync(join(home, "sessions"));
    for (const [i, sid] of ["explicit", "pattern", "plain", "answered", "busy", "shellask", "shellplain"].entries())
      writeFileSync(
        join(home, "sessions", `${i}.json`),
        JSON.stringify({ pid: process.pid, sessionId: sid, status: status[sid] ?? "idle" }),
      );
    writeFileSync(
      join(roots[1]!.path, "rollout-codex.jsonl"),
      lines(
        { type: "session_meta", timestamp: at, payload: { id: "cx", cwd: "/p" } },
        { type: "event_msg", timestamp: at, payload: { type: "task_started" } },
        {
          type: "response_item",
          timestamp: at,
          payload: {
            type: "custom_tool_call",
            name: "exec",
            input: `text(await tools.exec_command({cmd:"cfind ask \\"Pick A or B?\\""}))`,
          },
        },
        {
          type: "response_item",
          timestamp: at,
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "A is faster." }] },
        },
        { type: "event_msg", timestamp: at, payload: { type: "task_complete" } },
      ),
    );
    const monitor = new Monitor({ roots, dataDir: join(home, "data") });
    await monitor.refresh();
    const ask = (id: string) => monitor.snapshot().sessions.find((s) => s.id === id)?.ask;
    assert.equal(ask("explicit"), "Go with C?");
    assert.equal(ask("pattern"), "Then I re-run S10. Go?");
    assert.equal(ask("plain"), undefined);
    assert.equal(ask("answered"), undefined);
    assert.equal(ask("busy"), undefined);
    const state = (id: string) => monitor.snapshot().sessions.find((s) => s.id === id)?.state;
    assert.equal(ask("shellask"), "Your call: ship it?");
    assert.equal(state("shellask"), "idle");
    assert.equal(ask("shellplain"), undefined);
    assert.equal(state("shellplain"), "idle");
    assert.equal(ask("cx"), "Pick A or B?");
    assert.equal(monitor.snapshot().sessions.find((s) => s.id === "explicit")!.state, "idle");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a dashboard agent asks at the end of its turn and stops asking on the next message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-asks-agent-")),
    prior = process.env.CFIND_CLAUDE_BIN;
  writeFileSync(
    join(dir, "claude"),
    `#!/usr/bin/env node
const send=o=>console.log(JSON.stringify(o));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.type!=='user')return;const text=m.message.content;
 send({type:'system',subtype:'init',session_id:'s',model:'opus'});
 const id='r'+Math.random();
 if(text==='first'){
  send({type:'assistant',message:{id:id,content:[{type:'tool_use',id:'t1',name:'Bash',input:{command:'cfind ask "Deploy now?"'}}]}});
  send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'t1',content:'ok'}]}});
  send({type:'assistant',message:{id:id+'b',content:[{type:'text',text:'Ready to deploy.'}]}});
 } else send({type:'assistant',message:{id:id,content:[{type:'text',text:'Deployed.'}]}});
 send({type:'result',subtype:'success',is_error:false,result:''});
});`,
    { mode: 0o700 },
  );
  process.env.CFIND_CLAUDE_BIN = join(dir, "claude");
  const w = new AgentWorkspace([{ id: "claude", source: "claude", label: "Claude", path: dir }], join(dir, "data"));
  const until = async (f: () => boolean) => {
    const end = Date.now() + 5000;
    while (!f()) {
      if (Date.now() > end) throw new Error("Condition timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  try {
    const a = await w.create("claude", dir, "first");
    await until(() => a.state === "idle" && a.messages.some((m) => m.text === "Ready to deploy."));
    assert.equal(a.ask, "Deploy now?");
    await w.send(a.id, "yes");
    await until(() => a.messages.some((m) => m.text === "Deployed.") && a.state === "idle");
    assert.equal(a.ask, undefined);
  } finally {
    w.close();
    if (prior === undefined) delete process.env.CFIND_CLAUDE_BIN;
    else process.env.CFIND_CLAUDE_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cfind ask exits 0 and says what it did", () => {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "..", "dist", "cli.js"), "ask", "Go?"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /waiting for your answer/);
});
