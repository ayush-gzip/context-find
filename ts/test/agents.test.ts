import test from "node:test";
import assert from "node:assert/strict";
import { applyCodexEvent, applyClaudeEvent, newAgent } from "../src/agents.ts";
import { AgentWorkspace } from "../src/agents.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
    await w.send(a.id, "later");
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
    await w.respond(a.id, { allow: true, always: true });
    await until(
      () =>
        a.state === "idle" && a.messages.some((m) => m.text === "LATER:later"),
    );
    const texts = a.messages.map((m) => m.text);
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
