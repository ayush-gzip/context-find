import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer, type WebSocket } from "ws";
import { AgentWorkspace } from "../src/agents.ts";

test("Codex joins an existing thread, exposes commands and resolves the exact request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-codex-controls-"));
  const socket = join(dir, "control.sock"), server = createServer();
  const ws = new WebSocketServer({ server });
  const saved = { socket: process.env.CFIND_CODEX_SOCKET, binary: process.env.CFIND_CODEX_BIN };
  process.env.CFIND_CODEX_SOCKET = socket;
  delete process.env.CFIND_CODEX_BIN;
  const calls: any[] = [], answers: any[] = [];
  let client: WebSocket;
  ws.on("connection", (c) => {
    client = c;
    c.on("message", (data) => {
      const m = JSON.parse(String(data));
      if (!m.method) { answers.push(m); return; }
      calls.push(m);
      const reply = (result: any) => c.send(JSON.stringify({ id: m.id, result }));
      if (m.method === "initialize") reply({});
      if (m.method === "thread/resume") {
        c.send(JSON.stringify({ id: 41, method: "item/commandExecution/requestApproval", params: { threadId: "existing", command: "echo test" } }));
        reply({ thread: { id: "existing", status: { type: "active", activeFlags: ["waitingOnApproval"] }, turns: [{ id: "turn1", status: "inProgress" }] }, model: "codex-test", reasoningEffort: "medium" });
      }
      if (m.method === "model/list") reply({ data: [{ id: "codex-test", model: "codex-test", displayName: "Test model", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] }], nextCursor: null });
      if (m.method === "skills/list") reply({ data: [{ cwd: dir, skills: [{ name: "example-skill", description: "Example", path: "/fixture/SKILL.md", enabled: true }] }] });
      if (m.method === "permissionProfile/list") reply({ data: [], nextCursor: null });
      if (m.method === "turn/start") reply({ turn: { id: "turn2" } });
      if (m.method === "thread/compact/start") reply({});
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const w = new AgentWorkspace([{ id: "codex", source: "codex", label: "Codex", path: dir }], join(dir, "data"));
  const until = async (f: () => boolean) => {
    const end = Date.now() + 3000;
    while (!f()) { if (Date.now() > end) throw Error("Condition timed out"); await new Promise(r => setTimeout(r, 10)); }
  };
  try {
    const [a, same] = await Promise.all([w.attach("codex", dir, "existing", "/fixture/transcript.jsonl"), w.attach("codex", dir, "existing", "/fixture/transcript.jsonl")]);
    assert.equal(a.id, same.id);
    assert.equal(a.external, true);
    assert.equal(w.snapshot().agents.length, 1);
    assert.equal(a.pending?.id, 41);
    assert.deepEqual(calls.find(c => c.method === "thread/resume").params, { threadId: "existing", excludeTurns: true });
    const commands = await w.commands("codex", dir);
    assert.ok(commands.some(c => c.name === "model codex-test"));
    assert.ok(commands.some(c => c.name === "effort high"));
    assert.ok(commands.some(c => c.name === "example-skill"));
    await assert.rejects(w.respond(a.id, { allow: true, requestId: 40 }), /changed|pending|expired/i);
    assert.equal(answers.length, 0);
    await w.respond(a.id, { allow: false, requestId: 41 });
    await until(() => answers.length === 1);
    assert.deepEqual(answers[0], { id: 41, result: { decision: "decline" } });
    client!.send(JSON.stringify({ method: "item/tool/requestUserInput", id: 42, params: { threadId: "existing", questions: [{ id: "q", question: "Pick" }] } }));
    client!.send(JSON.stringify({ method: "item/tool/requestUserInput", id: 43, params: { threadId: "existing", questions: [{ id: "q2", question: "Next" }] } }));
    await until(() => a.pending?.id === 42);
    client!.send(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "existing", requestId: 42 } }));
    await until(() => a.pending?.id === 43);
    client!.send(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "existing", requestId: 43 } }));
    client!.send(JSON.stringify({ method: "turn/completed", params: { threadId: "existing", turn: { status: "completed" } } }));
    await until(() => !a.pending && a.state === "idle");
    await w.send(a.id, "/model codex-test");
    await w.send(a.id, "/effort high");
    // Codex 0.164 has no thread/settings/update; the picks go with the next turn.
    assert.ok(!calls.some(c => c.method === "thread/settings/update"));
    assert.equal(a.model, "codex-test");
    assert.equal(a.effort, "high");
    await assert.rejects(w.send(a.id, "/not-a-command"), /Unsupported|Unknown/);
    await w.send(a.id, "/example-skill do this");
    await until(() => calls.some(c => c.method === "turn/start"));
    const turn = calls.find(c => c.method === "turn/start").params, input = turn.input;
    assert.ok(input.some((i: any) => i.type === "skill" && i.path === "/fixture/SKILL.md"));
    assert.ok(input.some((i: any) => i.type === "text" && i.text === "do this"));
    assert.equal(turn.model, "codex-test");
    assert.equal(turn.effort, "high");
    client!.send(JSON.stringify({ method: "turn/completed", params: { threadId: "existing", turn: { status: "completed" } } }));
    await until(() => a.state === "idle");
    await w.send(a.id, "again");
    await until(() => calls.filter(c => c.method === "turn/start").length === 2);
    const second = calls.filter(c => c.method === "turn/start")[1].params;
    assert.equal(second.model, undefined);
    assert.equal(second.effort, undefined);
  } finally {
    w.close();
    ws.clients.forEach(c => c.terminate());
    await new Promise<void>(resolve => ws.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (saved.socket === undefined) delete process.env.CFIND_CODEX_SOCKET; else process.env.CFIND_CODEX_SOCKET = saved.socket;
    if (saved.binary === undefined) delete process.env.CFIND_CODEX_BIN; else process.env.CFIND_CODEX_BIN = saved.binary;
    rmSync(dir, { recursive: true, force: true });
  }
});
