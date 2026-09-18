import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sessionRow, machineRow } from "../src/rows.ts";
import { printTerminalError } from "../src/terminal.ts";

const escape = "\x1b]52;c;VEVTVA==\x07";

test("terminal rows sanitize metadata before truncation without changing the session", () => {
  const session = {
    path: "/fixture", cwd: "/project" + escape, branch: "main" + escape,
    summary: "hello" + escape, mtime: 1, host: "box" + escape,
    source: "codex" as const, sid: "id" + escape,
  };
  const original = structuredClone(session);
  const row = sessionRow(session);
  assert.equal(row.folder, "/project");
  assert.equal(row.branch, "main");
  assert.equal(row.host, "box");
  assert.equal(row.summary, "hello");
  assert.deepEqual(session, original);
  assert.deepEqual(machineRow("box" + escape, null, "offline" + escape),
    ["box", "-", "-", "-", "-", "offline"]);
});

test("CLI list output removes terminal controls while JSON retains execution metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "cfind-terminal-"));
  try {
    const sessions = join(root, ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    const cwd = "/project" + escape + "\u009b";
    const sid = "session" + escape + "\u009d";
    writeFileSync(join(sessions, "rollout-test.jsonl"), [
      { type: "session_meta", payload: { cwd, id: sid } },
      { type: "response_item", payload: { type: "message", role: "user",
        content: [{ type: "input_text", text: "hello" }] } },
    ].map((row) => JSON.stringify(row)).join("\n"));
    const options = { encoding: "utf8" as const, env: {
      ...process.env, HOME: root, USERPROFILE: root,
      CODEX_HOME: join(root, ".codex"), CLAUDE_CONFIG_DIR: join(root, ".claude"),
    }};
    const list = execFileSync(process.execPath, ["dist/cli.js", "--local", "--list"], options);
    assert.ok(!list.includes("\x1b"));
    assert.ok(list.includes("codex resume"));
    const json = JSON.parse(execFileSync(process.execPath,
      ["dist/cli.js", "--local", "--json"], options));
    assert.equal(json.sessions[0].cwd, cwd);
    assert.equal(json.sessions[0].sid, sid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal errors strip remote controls", () => {
  const original = console.error;
  let output = "";
  console.error = (text: string) => { output = text; };
  try {
    printTerminalError("box: " + escape + "failed");
    assert.equal(output, "box: failed");
  } finally {
    console.error = original;
  }
});
