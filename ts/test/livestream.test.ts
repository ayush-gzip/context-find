import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ConversationReader,
  readConversation,
  type ChatView,
} from "../src/conversation.ts";
import { ChatFeeds } from "../src/chatfeed.ts";
import { Deltas } from "../src/delta.ts";
import "../src/dashboard/delta.js";

const { applyDelta } = (globalThis as any).cfindDelta;
const jsonl = (rows: unknown[]) =>
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const wire = (o: unknown) => JSON.parse(JSON.stringify(o));
const PNG = "iVBORw0KGgo=";

const claudeRows = [
  { type: "user", uuid: "u1", isMeta: true, message: { content: "meta" } },
  {
    type: "user",
    uuid: "u2",
    timestamp: "2026-10-28T10:00:01Z",
    message: {
      content: [
        {
          type: "text",
          text: "Fix ünïcode 🙂 <system-reminder>x</system-reminder>",
        },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: PNG },
        },
      ],
    },
  },
  {
    type: "assistant",
    uuid: "a1",
    message: {
      content: [
        { type: "text", text: "Running" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ],
    },
  },
  {
    type: "user",
    uuid: "u3",
    message: {
      content: [{ type: "tool_result", tool_use_id: "t1", content: "a\nb" }],
    },
  },
  {
    type: "user",
    uuid: "c0",
    isMeta: true,
    promptId: "p1",
    message: { content: "<local-command-caveat>Caveat</local-command-caveat>" },
  },
  {
    type: "user",
    uuid: "c1",
    promptId: "p1",
    message: {
      content:
        "<command-name>/model</command-name><command-args>opus</command-args>",
    },
  },
  {
    type: "user",
    uuid: "c2",
    promptId: "p1",
    message: {
      content:
        "<local-command-stdout>Set model to `Opus`</local-command-stdout>",
    },
  },
  {
    type: "attachment",
    uuid: "q1",
    attachment: {
      type: "queued_command",
      origin: { kind: "human" },
      prompt: "also this",
    },
  },
  {
    type: "user",
    uuid: "n1",
    origin: { kind: "task-notification" },
    message: { content: "<summary>Build done</summary>" },
  },
  {
    type: "user",
    uuid: "k1",
    isCompactSummary: true,
    message: { content: "..." },
  },
  {
    type: "assistant",
    uuid: "a2",
    message: { content: [{ type: "text", text: "Done" }] },
  },
];
const codexRows = [
  { type: "session_meta", payload: { id: "x", cwd: "/p" } },
  {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    },
  },
  {
    type: "response_item",
    payload: {
      type: "function_call",
      call_id: "c1",
      name: "shell",
      arguments: '{"cmd":"ls"}',
    },
  },
  {
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "c1",
      output: '{"output":"ok"}',
    },
  },
  {
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Done" }],
    },
  },
];

/** What the apps do with chat-delta: replace by id, add new ones at the end. */
function merge(view: ChatView, delta: ChatView): ChatView {
  const byId = new Map(view.messages.map((m) => [m.id, m]));
  for (const m of delta.messages) byId.set(m.id, m);
  return { messages: [...byId.values()].slice(-400), omitted: delta.omitted };
}

test("reading a transcript in pieces equals reading it whole, at every split", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-inc-"));
  try {
    for (const [name, rows] of [
      ["claude", claudeRows],
      ["codex", codexRows],
    ] as const) {
      const path = join(dir, name + ".jsonl"),
        bytes = Buffer.from(jsonl(rows));
      writeFileSync(path, bytes);
      const whole = wire(readConversation(path));
      assert.ok(whole.messages.length >= 3, name);
      for (let k = 0; k <= bytes.length; k++) {
        writeFileSync(path, bytes.subarray(0, k));
        const reader = new ConversationReader(path);
        reader.update();
        let seen = wire(reader.view());
        appendFileSync(path, bytes.subarray(k));
        const delta = reader.update();
        assert.notEqual(delta, "reset");
        assert.deepEqual(wire(reader.view()), whole, `${name} split at ${k}`);
        seen = merge(seen, wire(delta));
        assert.deepEqual(seen, whole, `${name} merged at ${k}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a long transcript keeps memory flat and counts what it leaves out", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-inc-")),
    path = join(dir, "s.jsonl");
  try {
    const rows = Array.from({ length: 2500 }, (_, i) => ({
      type: "assistant",
      uuid: "a" + i,
      message: {
        content: [
          {
            type: "tool_use",
            id: "t" + i,
            name: "Bash",
            input: { command: "echo " + i },
          },
        ],
      },
    }));
    writeFileSync(path, jsonl(rows.slice(0, 1200)));
    const reader = new ConversationReader(path);
    reader.update();
    appendFileSync(
      path,
      jsonl([
        ...rows.slice(1200),
        {
          type: "user",
          uuid: "r",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "t2499", content: "last" },
            ],
          },
        },
      ]),
    );
    reader.update();
    const view = reader.view();
    assert.equal(view.messages.length, 400);
    assert.equal(view.omitted, 2100);
    assert.equal(view.messages.at(-1)!.tool!.output, "last");
    assert.deepEqual(wire(view), wire(readConversation(path)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a transcript that is cut short or replaced starts over", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-inc-")),
    path = join(dir, "s.jsonl");
  try {
    writeFileSync(path, jsonl(claudeRows));
    const reader = new ConversationReader(path);
    reader.update();
    writeFileSync(path, jsonl(claudeRows.slice(0, 2)));
    assert.equal(reader.update(), "reset");
    assert.deepEqual(wire(reader.view()), wire(readConversation(path)));
    const update = reader.update();
    assert.notEqual(update, "reset");
    assert.equal((update as ChatView).messages.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an open chat gets each new message within milliseconds, none lost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-feed-")),
    path = join(dir, "s.jsonl");
  const feeds = new ChatFeeds(10);
  try {
    writeFileSync(path, jsonl(claudeRows.slice(0, 2)));
    let view: ChatView | undefined;
    const got: { event: string; at: number }[] = [];
    const stop = feeds.subscribe(path, (event, v) => {
      got.push({ event, at: performance.now() });
      view = event === "chat" ? wire(v) : merge(view!, wire(v));
    });
    assert.equal(got[0]!.event, "chat");
    const start = performance.now();
    appendFileSync(path, jsonl([claudeRows[10]]));
    while (got.length < 2 && performance.now() - start < 2000)
      await new Promise((r) => setTimeout(r, 2));
    assert.equal(got[1]?.event, "chat-delta");
    // Well under the 1 s safety poll: the file watch delivered it.
    assert.ok(got[1]!.at - start < 250, `took ${got[1]!.at - start} ms`);

    for (let i = 0; i < 50; i++)
      appendFileSync(
        path,
        jsonl([
          {
            type: "assistant",
            uuid: "b" + i,
            message: { content: [{ type: "text", text: "m" + i }] },
          },
        ]),
      );
    const want = wire(readConversation(path));
    const until = performance.now() + 2000;
    while (
      JSON.stringify(view) !== JSON.stringify(want) &&
      performance.now() < until
    )
      await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(view, want);
    // Quick writes are sent together, not one frame each.
    assert.ok(got.length < 52, `${got.length} frames`);

    stop();
    const frames = got.length;
    appendFileSync(path, jsonl([claudeRows[2]]));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(got.length, frames, "no frames after the chat closes");
    assert.ok(readFileSync(path).length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A seeded generator keeps failures reproducible.
function rng(seed: number) {
  return () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}

test("merging deltas gives the same snapshot as sending it whole", () => {
  const rand = rng(7),
    pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const sessions = new Map<string, any>(),
    agents: any[] = [];
  let collecting = false;
  const snapshot = () => ({
    updatedAt: Math.floor(rand() * 3),
    collecting,
    profiles: [{ id: "claude", tokens: { input: sessions.size } }],
    sessions: [...sessions.values()]
      .map((s) => ({ ...s }))
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.path < b.path ? -1 : 1)),
    days: ["2026-10-27", "2026-10-28"].flatMap((day) =>
      ["claude", "personal"].map((profile) => ({
        day,
        profile,
        tokens: { input: sessions.size },
      })),
    ),
    usage: [...sessions.values()].map((s) => ({
      day: "2026-10-28",
      model: "opus",
      profile: "claude",
      cwd: s.path,
      tokens: { input: s.updatedAt },
    })),
    activity: [],
    agents: agents.map((a) => ({
      ...a,
      messages: a.messages.map((m: any) => ({ ...m })),
    })),
  });
  const server = new Deltas();
  let client = wire(snapshot());
  server.next(client);
  let frames = 0;
  for (let step = 0; step < 3000; step++) {
    const r = rand();
    if (r < 0.2) {
      const path = "/p/" + Math.floor(rand() * 40);
      sessions.set(path, {
        path,
        updatedAt: Math.floor(rand() * 50),
        state: pick(["idle", "running"]),
      });
    } else if (r < 0.3 && sessions.size)
      sessions.delete(pick([...sessions.keys()]));
    else if (r < 0.4 && sessions.size) {
      const s = sessions.get(pick([...sessions.keys()]));
      if (s.open) delete s.open;
      else s.open = true;
      s.updatedAt = Math.floor(rand() * 50);
    } else if (r < 0.45)
      agents.unshift({ id: "g" + step, state: "queued", messages: [] });
    else if (r < 0.5 && agents.length)
      agents.splice(Math.floor(rand() * agents.length), 1);
    else if (r < 0.75 && agents.length) {
      const a = pick(agents),
        last = a.messages.at(-1);
      if (last && rand() < 0.7) last.text += pick(["a", "b ", "\n", "🙂"]);
      else a.messages.push({ id: "m" + step, role: "assistant", text: "" });
      a.state = pick(["running", "waiting"]);
      if (rand() < 0.3) a.pending = rand() < 0.5 ? { id: step } : undefined;
      if (a.messages.length > 6) a.messages = a.messages.slice(-5);
    } else if (r < 0.8 && agents.length > 1) agents.push(agents.shift());
    else if (r < 0.85 && agents.length) {
      const a = pick(agents);
      if (a.messages.length)
        a.messages[0] = {
          ...a.messages[0],
          tool: { name: "Bash", output: String(step) },
        };
    } else collecting = !collecting;
    const snap = snapshot(),
      delta = server.next(snap);
    if (delta) {
      frames++;
      client = applyDelta(client, wire(delta));
    }
    assert.deepEqual(client, wire(snap), `step ${step}`);
  }
  assert.ok(frames > 1000);
});

test("a token costs a few bytes, not the whole agent list", () => {
  const agents = Array.from({ length: 5 }, (_, i) => ({
    id: "a" + i,
    state: "running",
    messages: Array.from({ length: 100 }, (_, j) => ({
      id: `m${j}`,
      role: "assistant",
      text: "x".repeat(300),
    })),
  }));
  const server = new Deltas();
  server.next(wire({ agents }));
  agents[2]!.messages[99]!.text += " next";
  const delta = server.next(wire({ agents }))!;
  assert.deepEqual(delta, {
    lists: {
      agents: {
        upsert: [{ id: "a2", messages: { append: [["m99", " next"]] } }],
      },
    },
  });
  assert.ok(JSON.stringify(delta).length < 100);
  assert.equal(server.next(wire({ agents })), undefined);
});
