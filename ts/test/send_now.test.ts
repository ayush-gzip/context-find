import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentWorkspace } from "../src/agents.ts";
import { procStart, sendKey, startInTmux, stopPane } from "../src/live.ts";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Condition timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const got = (a: { messages: { text: string }[] }) =>
  a.messages.filter((m) => m.text.startsWith("GOT ")).map((m) => m.text.slice(4));

test("Send now stops a Claude reply and sends the queued message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-sendnow-")),
    prior = process.env.CFIND_CLAUDE_BIN;
  // Like Claude 2.1: an interrupt ends the turn with a success result and no text.
  writeFileSync(
    join(dir, "claude"),
    `#!/usr/bin/env node
const send=o=>console.log(JSON.stringify(o));let timer;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.type==='user'){const text=m.message.content;
  send({type:'system',subtype:'init',session_id:'s',model:'opus'});
  timer=setTimeout(()=>{send({type:'assistant',message:{id:'r'+Math.random(),content:[{type:'text',text:'GOT '+text}]}});send({type:'result',subtype:'success',is_error:false,result:'done'});},text.includes('slow')?8000:20);}
 if(m.type==='control_request'&&m.request.subtype==='interrupt'){clearTimeout(timer);
  send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{still_queued:[]}}});
  send({type:'result',subtype:'success',is_error:false,result:''});}
});`,
    { mode: 0o700 },
  );
  process.env.CFIND_CLAUDE_BIN = join(dir, "claude");
  const w = new AgentWorkspace(
    [{ id: "claude", source: "claude", label: "Claude", path: dir }],
    join(dir, "data"),
  );
  try {
    const a = await w.create("claude", dir, "slow task");
    await until(() => a.state === "running" && !!a.sid);
    await assert.rejects(w.sendNow(a.id), /Nothing is waiting/);
    await w.send(a.id, "do this instead");
    assert.equal(a.queue.length, 1);
    const at = Date.now();
    await w.sendNow(a.id);
    await until(() => got(a).length === 1);
    assert.deepEqual(got(a), ["do this instead"]);
    assert.ok(Date.now() - at < 2000, "sent before the slow reply would end");
    assert.equal(a.error, undefined);
    assert.ok(!a.messages.some((m) => m.role === "note"));
  } finally {
    w.close();
    if (prior === undefined) delete process.env.CFIND_CLAUDE_BIN;
    else process.env.CFIND_CLAUDE_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Send now interrupts a Codex turn and starts the queued one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-sendnow-codex-")),
    prior = process.env.CFIND_CODEX_BIN;
  writeFileSync(
    join(dir, "codex"),
    `#!/usr/bin/env node
const send=o=>console.log(JSON.stringify(o));let n=0;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),p=m.params||{};
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'t'},model:'gpt'}});
 if(m.method==='turn/start'){const id='u'+(n++),text=p.input[0].text;send({id:m.id,result:{turn:{id}}});
  if(!text.includes('slow')){send({method:'item/completed',params:{threadId:'t',item:{type:'agentMessage',id:'r'+id,text:'GOT '+text}}});
   send({method:'turn/completed',params:{threadId:'t',turn:{id,status:'completed'}}});}}
 if(m.method==='turn/interrupt'){send({id:m.id,result:{}});send({method:'turn/completed',params:{threadId:'t',turn:{id:p.turnId,status:'interrupted'}}});}
});`,
    { mode: 0o700 },
  );
  process.env.CFIND_CODEX_BIN = join(dir, "codex");
  const w = new AgentWorkspace(
    [{ id: "codex", source: "codex", label: "Codex", path: dir }],
    join(dir, "data"),
  );
  try {
    const a = await w.create("codex", dir, "slow task");
    await until(() => a.state === "running" && !!a.turnId);
    await w.send(a.id, "do this instead");
    await w.sendNow(a.id);
    await until(() => got(a).length === 1);
    assert.deepEqual(got(a), ["do this instead"]);
  } finally {
    w.close();
    if (prior === undefined) delete process.env.CFIND_CODEX_BIN;
    else process.env.CFIND_CODEX_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "terminal Send now and Stop type Claude's keys into the pane",
  { skip: !hasTmux && "tmux is not installed" },
  async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "cfind-keys-"))),
      socket = "cfind-keys-" + process.pid,
      prior = process.env.CFIND_TMUX_BIN,
      log = join(dir, "keys.txt");
    // A scratch tmux server: the test never touches the default one.
    writeFileSync(join(dir, "tmux"), `#!/bin/sh\nexec tmux -L ${socket} "$@"\n`, {
      mode: 0o700,
    });
    // Writes each byte the pane gets, in hex.
    writeFileSync(
      join(dir, "keys.js"),
      `process.stdin.setRawMode(true);process.stdin.on('data',d=>require('node:fs').appendFileSync(${JSON.stringify(log)},d.toString('hex')+' '));`,
    );
    process.env.CFIND_TMUX_BIN = join(dir, "tmux");
    try {
      const { pane, pid } = startInTmux(dir, [process.execPath, join(dir, "keys.js")]);
      const r = {
        profile: "claude",
        sessionId: "s",
        pid,
        procStart: procStart(pid),
        tmux: pane,
        status: "running",
        updatedAt: Date.now(),
      };
      await new Promise((ok) => setTimeout(ok, 500));
      sendKey(r, "send-now");
      await until(() => existsSync(log) && readFileSync(log, "utf8").includes("13"));
      await stopPane(r);
      await until(() => readFileSync(log, "utf8").includes("7f"));
      // Ctrl+X Ctrl+S, then Esc, Ctrl+U, Backspace.
      assert.equal(readFileSync(log, "utf8").replace(/\s+/g, ""), "18131b157f");
      assert.throws(() => sendKey(r, "C-c"), /Unknown key/);
    } finally {
      spawnSync("tmux", ["-L", socket, "kill-server"]);
      // tmux leaves the socket file behind when its server is killed.
      rmSync(join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid!()}`, socket), { force: true });
      if (prior === undefined) delete process.env.CFIND_TMUX_BIN;
      else process.env.CFIND_TMUX_BIN = prior;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
