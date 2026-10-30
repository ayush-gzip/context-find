import test from "node:test";
import assert from "node:assert/strict";
import { applyCodexEvent, applyClaudeEvent, claudeRateLimits, newAgent } from "../src/agents.ts";
import { Monitor } from "../src/monitor.ts";
import { AgentWorkspace } from "../src/agents.ts";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  saveUpload,
  uploadIds,
  uploadPath,
  withPaths,
} from "../src/uploads.ts";

test("Codex streams text, waits for approvals and records child relationships", () => {
  const a = newAgent("codex", "/project", "task");
  applyCodexEvent(a, "turn/started", { turn: { id: "t1" } });
  applyCodexEvent(a, "item/agentMessage/delta", {
    itemId: "i1",
    delta: "Hello",
  });
  applyCodexEvent(a, "item/agentMessage/delta", {
    itemId: "i1",
    delta: " world",
  });
  assert.equal(a.messages[0]!.text, "Hello world");
  assert.equal(a.state, "running");
  applyCodexEvent(a, "item/started", {
    item: {
      type: "collabAgentToolCall",
      id: "childcall",
      receiverThreadIds: ["child"],
      prompt: "review",
      agentsStates: { child: { status: "running" } },
    },
  });
  assert.equal(a.children[0]!.id, "child");
  assert.equal(a.children[0]!.task, "review");
  applyCodexEvent(a, "turn/completed", {
    turn: { status: "failed", error: { message: "Quota reached" } },
  });
  assert.equal(a.state, "failed");
  assert.match(a.error!, /Quota/);
});
test("workspace queues prompts and resolves a tool approval through the Codex protocol", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-rpc-")),
    binary = join(dir, "codex"),
    prior = process.env.CFIND_CODEX_BIN;
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const readline=require('node:readline');let turn=0;
const send=o=>console.log(JSON.stringify(o));
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread1'},model:'test'}});
 if(m.method==='thread/resume')send({id:m.id,result:{thread:{id:'thread1'}}});
 if(m.method==='turn/start'){
  turn++;send({id:m.id,result:{turn:{id:'turn'+turn}}});
  setTimeout(()=>{
   if(turn===3)send({id:1000,method:'item/commandExecution/requestApproval',params:{threadId:'thread1',command:'echo hello'}});
   else{send({method:'item/agentMessage/delta',params:{threadId:'thread1',itemId:'i'+turn,delta:'reply'+turn}});send({method:'turn/completed',params:{threadId:'thread1',turn:{status:'completed'}}});}
  },80);
 }
 if(m.id===1000&&!m.method){send({method:'item/agentMessage/delta',params:{threadId:'thread1',itemId:'approved',delta:m.result.decision}});send({method:'turn/completed',params:{threadId:'thread1',turn:{status:'completed'}}});}
});`,
    { mode: 0o700 },
  );
  process.env.CFIND_CODEX_BIN = binary;
  const roots = join(dir, "sessions");
  mkdirSync(roots);
  const w = new AgentWorkspace(
    [{ id: "codex", source: "codex", label: "Codex", path: roots }],
    join(dir, "data"),
  );
  const until = async (check: () => boolean) => {
    const end = Date.now() + 4000;
    while (!check()) {
      if (Date.now() > end) throw new Error("Protocol condition timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  try {
    const a = await w.create("codex", dir, "first");
    await w.send(a.id, "second");
    await until(
      () => a.state === "idle" && a.messages.some((m) => m.text === "reply2"),
    );
    assert.deepEqual(
      a.messages.filter((m) => m.role === "user").map((m) => m.text),
      ["first", "second"],
    );
    assert.equal(a.queue.length, 0);
    await w.send(a.id, "approval");
    await until(() => a.state === "waiting");
    await w.respond(a.id, { allow: false });
    await until(() => a.state === "idle");
    assert.ok(a.messages.some((m) => m.text === "decline"));
    w.dismiss(a.id);
    assert.equal(w.snapshot().agents.length, 0);
  } finally {
    w.close();
    if (prior === undefined) delete process.env.CFIND_CODEX_BIN;
    else process.env.CFIND_CODEX_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
test("Claude streaming response and result do not repeat the same message", () => {
  const a = newAgent("personal", "/project", "task");
  applyClaudeEvent(a, {
    type: "system",
    subtype: "init",
    session_id: "sid",
    model: "opus",
  });
  applyClaudeEvent(a, {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  });
  applyClaudeEvent(a, {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    },
  });
  applyClaudeEvent(a, {
    type: "assistant",
    message: { id: "m1", content: [{ type: "text", text: "Hello" }] },
  });
  applyClaudeEvent(a, { type: "result", subtype: "success", result: "Hello" });
  assert.equal(a.messages.filter((m) => m.role === "assistant").length, 1);
  assert.equal(a.state, "idle");
  assert.equal(a.sid, "sid");
});
test("Claude questions, session approvals and queue edits use the stream-json control protocol", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-claude-")),
    binary = join(dir, "claude"),
    prior = process.env.CFIND_CLAUDE_BIN;
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const readline=require('node:readline');
const send=o=>console.log(JSON.stringify(o));
const args=process.argv.slice(2);
const stdio=args.join(' ').includes('--permission-prompt-tool stdio');
let turn=0;
const text=t=>send({type:'assistant',message:{id:'m'+Math.random(),content:[{type:'text',text:t}]}});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.type==='user'){
  turn++;
  if(turn===1){
   send({type:'system',subtype:'init',session_id:'sid1',model:'haiku'});
   text('MODE='+args[args.indexOf('--permission-mode')+1]);
   if(!stdio){send({type:'result',subtype:'error',is_error:true,result:'no prompt tool'});return;}
   send({type:'assistant',message:{id:'a1',content:[{type:'tool_use',id:'q',name:'AskUserQuestion',input:{questions:[{question:'Tea or coffee?'}]}}]}});
   setTimeout(()=>send({type:'control_request',request_id:'r1',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',input:{questions:[{question:'Tea or coffee?',header:'Drink',options:[{label:'Tea'},{label:'Coffee'}],multiSelect:false}]}}}),150);
  } else {text('LATER:'+m.message.content);send({type:'result',subtype:'success',result:'done'});}
 }
 if(m.type==='control_response'){
  const r=m.response.response;
  if(m.response.request_id==='r1'){
   send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'q',content:'answered'}]}});
   text('ANSWER='+r.updatedInput.answers['Tea or coffee?']);
   send({type:'control_request',request_id:'r2',request:{subtype:'can_use_tool',tool_name:'Write',input:{file_path:'/x'},permission_suggestions:[{type:'setMode',mode:'acceptEdits',destination:'session'},{type:'addRules',destination:'localSettings'}]}});
  }
  if(m.response.request_id==='r2'){
   text('WRITE='+r.behavior+':'+(r.updatedPermissions||[]).map(p=>p.destination).join(','));
   send({type:'result',subtype:'success',result:'done'});
  }
 }
});`,
    { mode: 0o700 },
  );
  process.env.CFIND_CLAUDE_BIN = binary;
  const w = new AgentWorkspace(
    [
      {
        id: "claude",
        source: "claude",
        label: "Claude",
        path: join(dir, ".claude", "projects"),
      },
    ],
    join(dir, "data"),
  );
  const until = async (check: () => boolean) => {
    const end = Date.now() + 4000;
    while (!check()) {
      if (Date.now() > end) throw new Error("Protocol condition timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  try {
    const a = await w.create("claude", dir, "first");
    await until(() => a.state === "running" && a.sid === "sid1");
    a.updatedAt = 1;
    await w.send(a.id, "later");
    assert.ok(a.updatedAt > 1, "queued input updates interaction time");
    await w.send(a.id, "drop");
    w.unqueue(a.id, 1);
    assert.deepEqual(
      a.queue.map((q) => q.text),
      ["later"],
    );
    assert.throws(() => w.unqueue(a.id, 5), /not found/);
    await until(() => a.pending?.params.tool_name === "AskUserQuestion");
    await w.respond(a.id, {
      allow: true,
      answers: { "Tea or coffee?": ["Coffee"] },
    });
    await until(() => a.pending?.params.tool_name === "Write");
    a.updatedAt = 1;
    await w.respond(a.id, { allow: true, always: true });
    assert.ok(a.updatedAt > 1, "approval answers update interaction time");
    await until(
      () =>
        a.state === "idle" && a.messages.some((m) => m.text === "LATER:later"),
    );
    const texts = a.messages.map((m) => m.text);
    assert.ok(texts.includes("MODE=auto"));
    assert.ok(texts.includes("ANSWER=Coffee"));
    assert.ok(texts.includes("WRITE=allow:session"));
    assert.equal(
      a.messages.find((m) => m.id === "q")!.tool!.output,
      "answered",
    );
    assert.deepEqual(
      a.messages.filter((m) => m.role === "user").map((m) => m.text),
      ["first", "Coffee", "later"],
    );
  } finally {
    w.close();
    if (prior === undefined) delete process.env.CFIND_CLAUDE_BIN;
    else process.env.CFIND_CLAUDE_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
test("saved legacy agents and resumed sessions retain manual permissions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-legacy-mode-")),
    binary = join(dir, "claude"),
    prior = process.env.CFIND_CLAUDE_BIN;
  writeFileSync(binary, `#!/usr/bin/env node
const args=process.argv.slice(2);
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 if(JSON.parse(line).type!=='user')return;
 console.log(JSON.stringify({type:'system',subtype:'init',session_id:'legacy',model:args[args.indexOf('--permission-mode')+1]}));
 console.log(JSON.stringify({type:'result',subtype:'success',result:'done'}));
});`, { mode: 0o700 });
  const legacy = newAgent("claude", dir, "saved");
  delete legacy.permissionMode;
  const data = join(dir, "data");
  mkdirSync(data);
  writeFileSync(join(data, "workspace.json"), JSON.stringify([legacy]));
  process.env.CFIND_CLAUDE_BIN = binary;
  const w = new AgentWorkspace([{id:"claude",source:"claude",label:"Claude",path:dir}], data);
  try {
    await w.send(legacy.id, "continue");
    const resumed = await w.create("claude", dir, "resume", "old-session");
    const deadline = Date.now() + 4000;
    while (w.snapshot().agents.some(a => a.state !== "idle")) {
      if (Date.now() > deadline) throw new Error("Agent start timed out");
      await new Promise(r => setTimeout(r, 20));
    }
    assert.equal(w.snapshot().agents.find(a => a.id === legacy.id)!.model, "manual");
    assert.equal(resumed.model, "manual");
  } finally {
    w.close();
    if (prior === undefined) delete process.env.CFIND_CLAUDE_BIN;
    else process.env.CFIND_CLAUDE_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
test("/model on a Claude agent uses the set_model control request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-claude-")),
    binary = join(dir, "claude"),
    prior = process.env.CFIND_CLAUDE_BIN;
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const send=o=>console.log(JSON.stringify(o));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.type==='user'){send({type:'system',subtype:'init',session_id:'sid1',model:'claude-opus'});send({type:'result',subtype:'success',result:'done'});}
 if(m.type==='control_request'&&m.request.subtype==='set_model'){
  const model=m.request.model;
  send(model==='bad'
   ?{type:'control_response',response:{subtype:'error',request_id:m.request_id,error:'Unknown model'}}
   :{type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{model:model?'claude-'+model:'claude-default'}}});
 }
});`,
    { mode: 0o700 },
  );
  process.env.CFIND_CLAUDE_BIN = binary;
  const w = new AgentWorkspace(
    [
      {
        id: "claude",
        source: "claude",
        label: "Claude",
        path: join(dir, ".claude", "projects"),
      },
    ],
    join(dir, "data"),
  );
  const until = async (check: () => boolean) => {
    const end = Date.now() + 4000;
    while (!check()) {
      if (Date.now() > end) throw new Error("Protocol condition timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  try {
    const a = await w.create("claude", dir, "first");
    await until(() => a.state === "idle" && a.model === "claude-opus");
    await w.send(a.id, "/model bad");
    await w.send(a.id, "/model sonnet");
    await until(() => a.model === "claude-sonnet");
    await w.send(a.id, " /model default ");
    await until(() => a.model === "claude-default");
    assert.equal(a.pickedModel, undefined);
    assert.deepEqual(
      a.messages.filter((m) => m.role !== "assistant").map((m) => m.text),
      [
        "first",
        "Could not change the model: Unknown model",
        "Model set to claude-sonnet",
        "Model set to claude-default",
      ],
    );
    assert.equal(a.queue.length, 0);
    assert.equal(a.state, "idle");
  } finally {
    w.close();
    if (prior === undefined) delete process.env.CFIND_CLAUDE_BIN;
    else process.env.CFIND_CLAUDE_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex tool items carry output and answers map to protocol responses", async () => {
  const a = newAgent("codex", "/project", "task");
  applyCodexEvent(a, "item/started", {
    item: { type: "commandExecution", id: "c", command: "npm test" },
  });
  applyCodexEvent(a, "item/completed", {
    item: {
      type: "commandExecution",
      id: "c",
      command: "npm test",
      aggregatedOutput: "1 failing",
      exitCode: 1,
    },
  });
  applyCodexEvent(a, "item/started", {
    item: {
      type: "fileChange",
      id: "f",
      changes: [{ path: "a.ts", diff: "+x" }],
    },
  });
  assert.equal(a.messages.length, 2);
  assert.deepEqual(a.messages[0]!.tool, {
    name: "Shell",
    input: "npm test",
    output: "1 failing",
    error: true,
  });
  assert.equal(a.messages[1]!.text, "a.ts");
  assert.match(a.messages[1]!.tool!.input, /a\.ts\n\+x/);

  const dir = mkdtempSync(join(tmpdir(), "cfind-rpc-")),
    binary = join(dir, "codex"),
    prior = process.env.CFIND_CODEX_BIN;
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const readline=require('node:readline');let turn=0;
const send=o=>console.log(JSON.stringify(o));
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'t'},model:'test'}});
 if(m.method==='thread/resume')send({id:m.id,result:{thread:{id:'t'}}});
 if(m.method==='turn/start'){
  turn++;send({id:m.id,result:{turn:{id:'turn'+turn}}});
  setTimeout(()=>turn===1
   ?send({id:2001,method:'item/tool/requestUserInput',params:{threadId:'t',questions:[{id:'q1',question:'Pick',options:[{label:'A'}]}]}})
   :send({id:2002,method:'item/commandExecution/requestApproval',params:{threadId:'t',command:'curl x'}}),50);
 }
 if((m.id===2001||m.id===2002)&&!m.method){send({method:'item/agentMessage/delta',params:{threadId:'t',itemId:'r'+m.id,delta:JSON.stringify(m.result)}});send({method:'turn/completed',params:{threadId:'t',turn:{status:'completed'}}});}
});`,
    { mode: 0o700 },
  );
  process.env.CFIND_CODEX_BIN = binary;
  const w = new AgentWorkspace(
    [
      {
        id: "codex",
        source: "codex",
        label: "Codex",
        path: join(dir, "sessions"),
      },
    ],
    join(dir, "data"),
  );
  const until = async (check: () => boolean) => {
    const end = Date.now() + 4000;
    while (!check()) {
      if (Date.now() > end) throw new Error("Protocol condition timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  try {
    const b = await w.create("codex", dir, "ask");
    await until(() => b.state === "waiting");
    await w.respond(b.id, { allow: true, answers: { q1: ["A", "typed"] } });
    await until(() => b.state === "idle");
    assert.ok(
      b.messages.some(
        (m) => m.text === '{"answers":{"q1":{"answers":["A","typed"]}}}',
      ),
    );
    await w.send(b.id, "run");
    await until(() => b.state === "waiting");
    await w.respond(b.id, { allow: true, always: true });
    await until(
      () =>
        b.state === "idle" &&
        b.messages.some((m) => m.text === '{"decision":"acceptForSession"}'),
    );
  } finally {
    w.close();
    if (prior === undefined) delete process.env.CFIND_CODEX_BIN;
    else process.env.CFIND_CODEX_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attached images reach Claude as image blocks and Codex as local images", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-images-")),
    prior = {
      CFIND_CLAUDE_BIN: process.env.CFIND_CLAUDE_BIN,
      CFIND_CODEX_BIN: process.env.CFIND_CODEX_BIN,
      CFIND_DATA_DIR: process.env.CFIND_DATA_DIR,
    };
  process.env.CFIND_DATA_DIR = join(dir, "data");
  // Each fake replies with what it received, so the test reads it back.
  writeFileSync(
    join(dir, "claude"),
    `#!/usr/bin/env node
const send=o=>console.log(JSON.stringify(o));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.type!=='user')return;
 send({type:'system',subtype:'init',session_id:'s',model:'haiku'});
 const c=m.message.content;
 send({type:'assistant',message:{id:'a',content:[{type:'text',text:'GOT '+JSON.stringify(c.map(b=>b.type==='image'?[b.source.media_type,b.source.data.length]:b.text))}]}});
 send({type:'result',subtype:'success',result:'done'});
});`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(dir, "codex"),
    `#!/usr/bin/env node
const send=o=>console.log(JSON.stringify(o));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'t'},model:'test'}});
 if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'u'}}});
  send({method:'item/agentMessage/delta',params:{threadId:'t',itemId:'r',delta:'GOT '+JSON.stringify(m.params.input)}});
  send({method:'turn/completed',params:{threadId:'t',turn:{status:'completed'}}});}
});`,
    { mode: 0o700 },
  );
  process.env.CFIND_CLAUDE_BIN = join(dir, "claude");
  process.env.CFIND_CODEX_BIN = join(dir, "codex");
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    Buffer.alloc(30, 2),
  ]);
  const id = saveUpload(png)!,
    path = uploadPath(id);
  const w = new AgentWorkspace(
    [
      { id: "claude", source: "claude", label: "Claude", path: join(dir, "c") },
      { id: "codex", source: "codex", label: "Codex", path: join(dir, "x") },
    ],
    join(dir, "data"),
  );
  const reply = async (a: { messages: { text: string }[] }) => {
    const end = Date.now() + 4000;
    for (;;) {
      const m = a.messages.find((m) => m.text.startsWith("GOT "));
      if (m) return JSON.parse(m.text.slice(4));
      if (Date.now() > end) throw new Error("No reply");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  try {
    const c = await w.create(
      "claude",
      dir,
      "What is this?",
      undefined,
      undefined,
      [id],
    );
    assert.deepEqual(await reply(c), [
      ["image/png", png.toString("base64").length],
      "What is this?",
    ]);
    assert.deepEqual(c.messages[0]!.images, [id]);
    const x = await w.create("codex", dir, "", undefined, undefined, [id]);
    assert.deepEqual(await reply(x), [{ type: "localImage", path }]);
    assert.equal(withPaths("Look", [id]), `Look\nImage: ${path}`);
    assert.throws(() => uploadIds(["../x.png"]), /Bad image id/);
    assert.throws(() => uploadIds([id, id, id, id, id]), /up to 4/);
  } finally {
    w.close();
    for (const [k, v] of Object.entries(prior))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  }
});
test("Shift+Tab mode and ! commands on a Claude agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-claude-mode-")),
    binary = join(dir, "claude"),
    prior = process.env.CFIND_CLAUDE_BIN;
  // Replies like Claude 2.1: a status event after each mode change; the third change fails.
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const send=o=>console.log(JSON.stringify(o)),args=process.argv.slice(2);
let mode=args[args.indexOf('--permission-mode')+1],changes=0;
if(mode==='manual')mode='default';
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.type==='user'){
  send({type:'system',subtype:'init',session_id:'s',model:'opus',permissionMode:mode});
  send({type:'assistant',message:{id:'r'+Math.random(),content:[{type:'text',text:'GOT '+JSON.stringify(m.message.content)}]}});
  send({type:'result',subtype:'success',result:'done'});
 }
 if(m.type==='control_request'&&m.request.subtype==='set_permission_mode'){
  if(++changes===3)return send({type:'control_response',response:{subtype:'error',request_id:m.request_id,error:'Auto mode is unavailable',error_code:'auto_mode_unavailable'}});
  mode=m.request.mode;
  send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{mode}}});
  send({type:'system',subtype:'status',status:null,permissionMode:mode});
 }
});`,
    { mode: 0o700 },
  );
  process.env.CFIND_CLAUDE_BIN = binary;
  const w = new AgentWorkspace(
    [{ id: "claude", source: "claude", label: "Claude", path: dir }],
    join(dir, "data"),
  );
  const until = async (check: () => boolean) => {
    const end = Date.now() + 5000;
    while (!check()) {
      if (Date.now() > end) throw new Error("Condition timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const got = (a: { messages: { text: string }[] }) =>
    a.messages.filter((m) => m.text.startsWith("GOT ")).map((m) => JSON.parse(m.text.slice(4)));
  try {
    const a = await w.create("claude", dir, "first");
    await until(() => a.state === "idle");
    assert.equal(a.permissionMode, "auto");
    w.setMode(a.id, "manual");
    await until(() => a.permissionMode === "manual");
    w.setMode(a.id, "auto");
    await until(() => a.permissionMode === "auto");
    w.setMode(a.id, "manual");
    await until(() => a.messages.some((m) => m.role === "note"));
    assert.equal(a.permissionMode, "auto");
    assert.equal(a.messages.at(-1)!.text, "Could not change the mode: Auto mode is unavailable");
    assert.throws(() => w.setMode(a.id, "plan"), /Unknown mode/);

    // The slow first command still comes first: the order typed, not the order finished.
    await w.send(a.id, "! sleep 0.3; echo hi && echo 'a<b' >&2");
    await w.send(a.id, "!true");
    await w.send(a.id, "! head -c 40000 /dev/zero | tr '\\0' x");
    await until(() => a.messages.filter((m) => m.tool?.output !== undefined).length === 3);
    const shells = a.messages.filter((m) => m.tool?.name === "Shell");
    assert.deepEqual(shells.map((m) => m.text), [
      "! sleep 0.3; echo hi && echo 'a<b' >&2",
      "! true",
      "! head -c 40000 /dev/zero | tr '\\0' x",
    ]);
    assert.equal(shells[0]!.tool!.output, "hi\n\na<b\n");
    assert.equal(shells[1]!.tool!.output, "(no output)");
    await assert.rejects(w.send(a.id, "!  "), /Type a command after !/);
    await assert.rejects(w.send(a.id, "! ls", ["x"]), /without image attachments/);

    await w.send(a.id, "next");
    await until(() => got(a).length === 2);
    const text: string = got(a)[1];
    const parts = text.split("\n\n");
    assert.deepEqual(parts.slice(0, 2), [
      "<bash-input>sleep 0.3; echo hi &amp;&amp; echo 'a&lt;b' &gt;&amp;2</bash-input>\n<bash-stdout>hi\n</bash-stdout><bash-stderr>a&lt;b\n</bash-stderr>",
      "<bash-input>true</bash-input>\n<bash-stdout>(Bash completed with no output)</bash-stdout><bash-stderr></bash-stderr>",
    ]);
    assert.ok(parts[2]!.includes("x".repeat(30000) + "</bash-stdout>"));
    assert.ok(text.endsWith("\n\nnext"));
    assert.equal(a.messages.filter((m) => m.role === "user").at(-1)!.text, "next");

    // A command still running goes with a later message.
    await w.send(a.id, "! sleep 0.4; echo late");
    await w.send(a.id, "now");
    await until(() => got(a).length === 3);
    assert.equal(got(a)[2], "now");
    await until(() => a.messages.some((m) => m.tool?.output === "late\n"));
    await w.send(a.id, "later");
    await until(() => got(a).length === 4);
    assert.ok(got(a)[3].startsWith("<bash-input>sleep 0.4; echo late</bash-input>"));
    assert.ok(got(a)[3].endsWith("\n\nlater"));

    // Without a running Claude, the mode waits for the next start.
    await w.cancel(a.id);
    w.setMode(a.id, "manual");
    assert.equal(a.permissionMode, "manual");
    await w.send(a.id, "again");
    await until(() => a.state === "idle" && got(a).length === 5);
    assert.equal(a.permissionMode, "manual");
    assert.equal(got(a)[4], "again");
  } finally {
    w.close();
    if (prior === undefined) delete process.env.CFIND_CLAUDE_BIN;
    else process.env.CFIND_CLAUDE_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
test("Codex mode changes set the approval policy once and ! uses its shell command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-codex-mode-")),
    prior = process.env.CFIND_CODEX_BIN;
  writeFileSync(
    join(dir, "codex"),
    `#!/usr/bin/env node
const send=o=>console.log(JSON.stringify(o));let start,n=0;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),p=m.params||{};
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start'){start=p.approvalPolicy;send({id:m.id,result:{thread:{id:'t'},model:'gpt',approvalPolicy:start}});}
 if(m.method==='thread/resume')send({id:m.id,result:{thread:{id:p.threadId,status:{type:'idle'}},model:'gpt',approvalPolicy:'on-request'}});
 if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'u'+n}}});
  send({method:'item/completed',params:{threadId:p.threadId,item:{type:'agentMessage',id:'r'+(n++),text:'GOT '+JSON.stringify({start,turn:p.approvalPolicy??null})}}});
  send({method:'turn/completed',params:{threadId:p.threadId,turn:{status:'completed'}}});}
 if(m.method==='thread/shellCommand'){send({id:m.id,result:{}});
  const item={type:'commandExecution',id:'sh',command:"/bin/zsh -lc '"+p.command+"'",source:'userShell',commandActions:[{type:'unknown',command:p.command}],status:'inProgress',aggregatedOutput:null,exitCode:null};
  send({method:'item/started',params:{threadId:p.threadId,item}});
  send({method:'item/completed',params:{threadId:p.threadId,item:{...item,status:'completed',aggregatedOutput:'file\\n',exitCode:0}}});}
});`,
    { mode: 0o700 },
  );
  process.env.CFIND_CODEX_BIN = join(dir, "codex");
  const w = new AgentWorkspace(
    [{ id: "codex", source: "codex", label: "Codex", path: dir }],
    join(dir, "data"),
  );
  const until = async (check: () => boolean) => {
    const end = Date.now() + 5000;
    while (!check()) {
      if (Date.now() > end) throw new Error("Condition timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const got = (a: { messages: { text: string }[] }) =>
    a.messages.filter((m) => m.text.startsWith("GOT ")).map((m) => JSON.parse(m.text.slice(4)));
  try {
    const a = await w.create("codex", dir, "one");
    await until(() => a.state === "idle" && got(a).length === 1);
    assert.equal(a.permissionMode, "auto");
    w.setMode(a.id, "manual");
    await w.send(a.id, "two");
    await until(() => got(a).length === 2);
    await w.send(a.id, "three");
    await until(() => got(a).length === 3);
    assert.deepEqual(got(a), [
      { start: "on-request", turn: null },
      { start: "on-request", turn: "untrusted" },
      { start: "on-request", turn: null },
    ]);
    await w.send(a.id, "! ls");
    await until(() => a.messages.some((m) => m.tool?.output === "file\n"));
    assert.equal(a.messages.find((m) => m.id === "sh")!.text, "! ls");

    // A resumed thread shows the policy it already has.
    const r = await w.create("codex", dir, "resume", "old-thread");
    await until(() => r.state === "idle" && got(r).length === 1);
    assert.equal(r.permissionMode, "auto");
  } finally {
    w.close();
    if (prior === undefined) delete process.env.CFIND_CODEX_BIN;
    else process.env.CFIND_CODEX_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
test("headless Claude agents report usage limits like the statusline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-limits-")),
    binary = join(dir, "claude"),
    prior = process.env.CFIND_CLAUDE_BIN;
  writeFileSync(binary, `#!/usr/bin/env node
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 if(JSON.parse(line).type!=='user')return;
 const out=o=>console.log(JSON.stringify(o));
 out({type:'system',subtype:'init',session_id:'headless',model:'haiku'});
 out({type:'rate_limit_event',session_id:'headless',rate_limit_info:{utilization:0.78,unifiedWindows:{five_hour:{utilization:0.13,resetsAt:1793262000},seven_day:{utilization:0.78,resetsAt:1793408400}}}});
 // An event without the numbers must not replace the good one.
 out({type:'rate_limit_event',session_id:'headless',rate_limit_info:{status:'allowed'}});
 out({type:'result',subtype:'success',result:'done'});
});`, { mode: 0o700 });
  const data = join(dir, "data"),
    profiles = [{ id: "personal", source: "claude" as const, label: "Personal", path: dir }];
  mkdirSync(data);
  process.env.CFIND_CLAUDE_BIN = binary;
  const w = new AgentWorkspace(profiles, data);
  try {
    await w.create("personal", dir, "hi");
    const deadline = Date.now() + 4000;
    while (w.snapshot().agents.some(a => a.state !== "idle")) {
      if (Date.now() > deadline) throw new Error("Agent start timed out");
      await new Promise(r => setTimeout(r, 20));
    }
    const files = readdirSync(join(data, "signals"));
    assert.equal(files.length, 1);
    const signal = JSON.parse(readFileSync(join(data, "signals", files[0]!), "utf8"));
    assert.equal(signal.kind, "statusline");
    assert.equal(signal.profile, "personal");
    assert.equal(signal.sessionId, "headless");
    assert.deepEqual(signal.rate_limits, {
      five_hour: { used_percentage: 13, resets_at: 1793262000 },
      seven_day: { used_percentage: 78, resets_at: 1793408400 },
    });
    const limits = new Monitor({ roots: profiles, dataDir: data }).snapshot().profiles[0]!.limits!;
    assert.equal(limits.session!.used, 13);
    assert.equal(limits.week!.used, 78);
    assert.equal(limits.session!.resetsAt, 1793262000);
  } finally {
    w.close();
    if (prior === undefined) delete process.env.CFIND_CLAUDE_BIN;
    else process.env.CFIND_CLAUDE_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
test("claudeRateLimits keeps only windows with numbers", () => {
  assert.equal(claudeRateLimits(undefined), undefined);
  assert.equal(claudeRateLimits({ utilization: 0.5, resetsAt: 1 }), undefined);
  assert.deepEqual(
    claudeRateLimits({ unifiedWindows: { five_hour: { utilization: 0.4 }, seven_day: { utilization: 0.255, resetsAt: 9 } } }),
    { seven_day: { used_percentage: 26, resets_at: 9 } },
  );
});
