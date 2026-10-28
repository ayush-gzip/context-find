import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readConversation } from "../src/conversation.ts";

const jsonl = (rows: unknown[]) =>
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

test("Claude transcript becomes chat messages with paired tool output", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-chat-")),
    path = join(dir, "s.jsonl");
  writeFileSync(
    path,
    jsonl([
      {
        type: "user",
        uuid: "u1",
        isMeta: true,
        message: { content: "Base directory for this skill" },
      },
      {
        type: "user",
        uuid: "u2",
        timestamp: "2026-10-27T10:00:01Z",
        message: {
          content:
            "Fix it <system-reminder>secret</system-reminder>\n\x1b]52;c;evil\x07now",
        },
      },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-10-27T10:00:02Z",
        message: {
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "Here:\n```py\ndef f():\n    return 1\n```" },
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: "npm   test", description: "Run tests" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "u3",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              is_error: true,
              content: [{ type: "text", text: "1 failing" }],
            },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "s1",
        isSidechain: true,
        message: { content: [{ type: "text", text: "sidechain" }] },
      },
      "not json",
    ]).replace('"not json"', "{partial"),
  );
  try {
    const { messages, omitted } = readConversation(path);
    assert.equal(omitted, 0);
    assert.deepEqual(
      messages.map((m) => m.role),
      ["user", "assistant", "tool"],
    );
    assert.equal(messages[0]!.text, "Fix it  \nnow");
    assert.equal(messages[0]!.time, Date.parse("2026-10-27T10:00:01Z"));
    assert.match(messages[1]!.text, /def f\(\):\n {4}return 1/);
    assert.equal(messages[2]!.text, "npm test");
    assert.equal(messages[2]!.tool!.name, "Bash");
    assert.match(messages[2]!.tool!.input, /"description": "Run tests"/);
    assert.equal(messages[2]!.tool!.output, "1 failing");
    assert.equal(messages[2]!.tool!.error, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex rollout pairs calls with outputs and hides injected context", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-chat-")),
    path = join(dir, "rollout.jsonl"),
    item = (payload: unknown) => ({
      type: "response_item",
      timestamp: "2026-10-27T10:00:00Z",
      payload,
    });
  writeFileSync(
    path,
    jsonl([
      { type: "session_meta", payload: { id: "sid", cwd: "/p" } },
      item({
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "# AGENTS.md instructions for /p" },
        ],
      }),
      item({
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "rules" }],
      }),
      item({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "List files" }],
      }),
      item({ type: "reasoning", summary: [] }),
      item({
        type: "function_call",
        name: "exec_command",
        call_id: "c1",
        arguments: '{"cmd":"ls -la"}',
      }),
      item({
        type: "function_call_output",
        call_id: "c1",
        output: '{"output":"a\\nb","metadata":{"exit_code":0}}',
      }),
      item({
        type: "custom_tool_call",
        name: "apply_patch",
        call_id: "c2",
        input: "*** Begin Patch",
      }),
      item({
        type: "custom_tool_call_output",
        call_id: "c2",
        output: [{ type: "input_text", text: "Done" }],
      }),
      item({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Two files." }],
      }),
      item({
        type: "custom_tool_call",
        name: "exec",
        call_id: "c3",
        input: 'text(await tools.exec_command({cmd:"git status\\n  -s"}))',
      }),
    ]),
  );
  try {
    const { messages } = readConversation(path);
    assert.deepEqual(
      messages.map((m) => m.role),
      ["user", "tool", "tool", "assistant", "tool"],
    );
    assert.equal(messages[4]!.text, "git status -s");
    assert.equal(messages[0]!.text, "List files");
    assert.equal(messages[1]!.text, "ls -la");
    assert.equal(messages[1]!.tool!.output, "a\nb");
    assert.equal(messages[2]!.tool!.output, "Done");
    assert.equal(messages[3]!.text, "Two files.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("large transcripts keep the newest messages and cap tool output", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-chat-")),
    path = join(dir, "big.jsonl"),
    rows: unknown[] = [];
  for (let i = 0; i < 450; i++)
    rows.push({
      type: "user",
      uuid: "u" + i,
      message: { content: "message " + i },
    });
  rows.push({
    type: "assistant",
    uuid: "a",
    message: {
      content: [
        { type: "tool_use", id: "t", name: "Read", input: { file_path: "/x" } },
      ],
    },
  });
  rows.push({
    type: "user",
    uuid: "r",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "t", content: "x".repeat(20000) },
      ],
    },
  });
  writeFileSync(path, jsonl(rows));
  try {
    const { messages, omitted } = readConversation(path);
    assert.equal(messages.length, 400);
    assert.equal(omitted, 51);
    assert.equal(messages[0]!.text, "message 51");
    assert.ok(messages.at(-1)!.tool!.output!.length < 8100);
    assert.match(messages.at(-1)!.tool!.output!, /12000 more characters$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a message typed while Claude works shows as a user message", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-chat-")),
    path = join(dir, "s.jsonl"),
    queued = (prompt: unknown, kind = "human") => ({
      type: "attachment",
      uuid: "q-" + kind,
      timestamp: "2026-10-27T12:38:17.365Z",
      attachment: {
        type: "queued_command",
        prompt,
        commandMode: "prompt",
        origin: { kind },
      },
    });
  writeFileSync(
    path,
    jsonl([
      { type: "user", uuid: "u1", message: { content: "Run sleep 20" } },
      {
        type: "queue-operation",
        operation: "enqueue",
        content: "Also say MID-OK",
      },
      queued("Also say MID-OK"),
      queued("from a hook", "system"),
      {
        type: "assistant",
        uuid: "a1",
        message: { content: [{ type: "text", text: "DONE MID-OK" }] },
      },
    ]),
  );
  try {
    const { messages } = readConversation(path);
    assert.deepEqual(
      messages.map((m) => [m.role, m.text]),
      [
        ["user", "Run sleep 20"],
        ["user", "Also say MID-OK"],
        ["assistant", "DONE MID-OK"],
      ],
    );
    assert.equal(messages[1]!.time, Date.parse("2026-10-27T12:38:17.365Z"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("images in user messages come back as checked data URLs", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-chat-")),
    claudePath = join(dir, "c.jsonl"),
    codexPath = join(dir, "x.jsonl"),
    image = (media_type: string, data = "iVBORw0KGgo=") => ({
      type: "image",
      source: { type: "base64", media_type, data },
    });
  writeFileSync(
    claudePath,
    jsonl([
      {
        type: "user",
        uuid: "u1",
        message: {
          content: [
            image("image/png"),
            image("image/svg+xml"),
            image("image/png", 'bad"><script>'),
            { type: "text", text: "What is this?" },
          ],
        },
      },
      { type: "user", uuid: "u2", message: { content: [image("image/jpeg")] } },
    ]),
  );
  writeFileSync(
    codexPath,
    jsonl([
      { type: "session_meta", payload: { id: "x", cwd: "/p" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "data:image/webp;base64,UklGRg==",
            },
            { type: "input_image", image_url: "https://example.com/a.png" },
          ],
        },
      },
    ]),
  );
  try {
    const c = readConversation(claudePath).messages;
    assert.deepEqual(c[0]!.images, ["data:image/png;base64,iVBORw0KGgo="]);
    assert.equal(c[0]!.text, "What is this?");
    assert.deepEqual(c[1]!.images, ["data:image/jpeg;base64,iVBORw0KGgo="]);
    assert.equal(c[1]!.text, "");
    const x = readConversation(codexPath).messages;
    assert.deepEqual(x[0]!.images, ["data:image/webp;base64,UklGRg=="]);
    // Past the response budget, the newest images stay and older ones become a note.
    const big = "A".repeat(5 * 1024 * 1024);
    writeFileSync(
      claudePath,
      jsonl([
        {
          type: "user",
          uuid: "o",
          message: { content: [image("image/png", big)] },
        },
        {
          type: "user",
          uuid: "n",
          message: { content: [image("image/png", big)] },
        },
      ]),
    );
    const capped = readConversation(claudePath).messages;
    assert.equal(capped[1]!.images!.length, 1);
    assert.equal(capped[0]!.images, undefined);
    assert.equal(capped[0]!.text, "[1 image not shown]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task notices show as a note and paste tags are removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-chat-")),
    path = join(dir, "s.jsonl");
  writeFileSync(
    path,
    jsonl([
      {
        type: "user",
        uuid: "u1",
        origin: { kind: "human" },
        message: {
          content:
            'refer to \n\n<pasted_content id="a1cc">\nAcme profiles\n</pasted_content id="a1cc">\n',
        },
      },
      {
        type: "user",
        uuid: "t1",
        origin: { kind: "task-notification" },
        message: {
          content:
            "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command \"Deploy\" completed (exit code 0)</summary>\n</task-notification>",
        },
      },
      {
        type: "user",
        uuid: "t2",
        origin: { kind: "task-notification" },
        message: { content: "<task-notification>\n</task-notification>" },
      },
    ]),
  );
  try {
    assert.deepEqual(
      readConversation(path).messages.map((m) => [m.role, m.text]),
      [
        ["user", "refer to \n\n\nAcme profiles"],
        ["note", 'Background command "Deploy" completed (exit code 0)'],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commands run in Claude Code's terminal show as one grey line", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-chat-")),
    path = join(dir, "s.jsonl"),
    caveat = (promptId: string) => ({
      type: "user",
      isMeta: true,
      promptId,
      message: {
        content:
          "<local-command-caveat>The command below was run directly in Claude Code.</local-command-caveat>",
      },
    });
  writeFileSync(
    path,
    jsonl([
      caveat("p1"),
      {
        type: "user",
        uuid: "a",
        promptId: "p1",
        message: { content: "Commands are in the form `/command [args]`" },
      },
      caveat("p2"),
      {
        type: "user",
        uuid: "b",
        promptId: "p2",
        message: {
          content:
            "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus</command-args>",
        },
      },
      {
        type: "user",
        uuid: "c",
        promptId: "p2",
        message: {
          content:
            "<local-command-stdout>Set model to `Opus 5.5`</local-command-stdout>",
        },
      },
      {
        type: "user",
        uuid: "d",
        promptId: "p3",
        message: {
          content:
            "<command-name>/clear</command-name>\n<command-args></command-args>",
        },
      },
      {
        type: "user",
        uuid: "e",
        promptId: "p3",
        message: { content: "<local-command-stdout></local-command-stdout>" },
      },
      {
        type: "user",
        uuid: "f",
        promptId: "p4",
        message: { content: "can this not be solved?" },
      },
    ]),
  );
  try {
    assert.deepEqual(
      readConversation(path).messages.map((m) => [m.role, m.text]),
      [
        ["note", "Commands are in the form /command [args]"],
        ["note", "/model opus: Set model to Opus 5.5"],
        ["note", "/clear"],
        ["user", "can this not be solved?"],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
