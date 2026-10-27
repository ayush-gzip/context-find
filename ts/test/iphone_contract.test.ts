import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Monitor } from "../src/monitor.ts";
import { applyCodexEvent, newAgent } from "../src/agents.ts";

// The iPhone app (cfind-apple, cfind/Models.swift) decodes these fields without a
// default. If one goes missing, the whole event fails to decode on the phone.
const need = (o: any, fields: Record<string, string>, where: string) => {
  for (const [key, type] of Object.entries(fields))
    assert.equal(typeof o?.[key], type, `${where}.${key}`);
};
const wire = (o: unknown) => JSON.parse(JSON.stringify(o));

test("the metrics snapshot keeps the fields the iPhone app needs", async () => {
  const home = mkdtempSync(join(tmpdir(), "cfind-contract-"));
  try {
    const roots = [
      {
        id: "claude",
        label: "Claude",
        source: "claude" as const,
        path: join(home, "claude"),
      },
    ];
    mkdirSync(roots[0]!.path);
    writeFileSync(
      join(roots[0]!.path, "s1.jsonl"),
      JSON.stringify({
        type: "user",
        timestamp: "2026-10-27T10:00:00Z",
        sessionId: "s1",
        cwd: "/project",
        message: { role: "user", content: "hello" },
      }) + "\n",
    );
    const monitor = new Monitor({ roots, dataDir: join(home, "data") });
    await monitor.refresh();
    const snap = wire(monitor.snapshot());
    assert.ok(Array.isArray(snap.profiles) && Array.isArray(snap.sessions));
    need(snap.profiles[0], { id: "string", label: "string", source: "string" }, "profile");
    need(
      snap.sessions[0],
      {
        id: "string",
        profile: "string",
        source: "string",
        path: "string",
        cwd: "string",
        title: "string",
        updatedAt: "number",
        state: "string",
      },
      "session",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("workspace agents keep the fields the iPhone app needs", () => {
  const a = newAgent("codex", "/project", "task");
  applyCodexEvent(a, "item/agentMessage/delta", { itemId: "i1", delta: "Hi" });
  applyCodexEvent(a, "item/started", {
    item: { type: "commandExecution", id: "c", command: "npm test" },
  });
  a.pending = { id: 7, method: "item/commandExecution/requestApproval", params: {} };
  a.queue.push({ text: "next" });
  const agent = wire(a);
  need(
    agent,
    {
      id: "string",
      profile: "string",
      cwd: "string",
      title: "string",
      state: "string",
      startedAt: "number",
      updatedAt: "number",
    },
    "agent",
  );
  assert.ok(Array.isArray(agent.messages) && Array.isArray(agent.queue));
  for (const m of agent.messages)
    need(m, { id: "string", role: "string", text: "string" }, "message");
  need(agent.messages[1].tool, { name: "string", input: "string" }, "tool");
  need(agent.queue[0], { text: "string" }, "queue");
  need(agent.pending, { method: "string" }, "pending");
});
