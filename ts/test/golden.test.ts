/**
 * The Python and TypeScript scanners must agree.
 *
 * store.py is canonical and is what runs on remote machines. store.ts runs
 * locally. If a change lands in one and not the other, a remote row and a
 * local row would disagree about the same conversation. These tests render
 * identical fixtures through both and diff the result.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { header, renderTranscript, searchLocalTranscripts } from "../src/store.ts";
import { relativeTime } from "../src/store.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGENT = join(REPO, "src", "context_find", "store.py");

const CONVO = [
  { type: "summary" },
  { type: "user", cwd: "/w/proj", gitBranch: "main", timestamp: "2026-08-10T10:00:00Z",
    message: { content: "<command-name>/foo</command-name>" } },
  { type: "user", cwd: "/w/proj", gitBranch: "main", timestamp: "2026-08-10T10:01:00Z",
    message: { content: "fix  the\nEBS scan across every single one of the accounts we own" } },
  { type: "assistant", timestamp: "2026-08-10T10:02:00Z", message: { content: [
    { type: "text", text: "Looking now. This sentence exists to force a wrap at narrow widths." },
    { type: "tool_use", name: "Bash", input: { command: "aws ec2 describe-volumes" } }] } },
  { type: "user", cwd: "/w/proj", timestamp: "2026-08-10T10:03:00Z",
    message: { content: [{ type: "tool_result", content: "x".repeat(40) }] } },
];

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "context-find-golden-"));
  const path = join(dir, "a.jsonl");
  writeFileSync(path, CONVO.map((row) => JSON.stringify(row)).join("\n"), "utf8");
  return path;
}

function pythonRender(path: string, width: number, showAll: boolean, ascii: boolean) {
  // Call the pure renderer directly. The --render CLI now guards path
  // containment (see security_and_fixes), which these tmp fixtures would trip.
  const out = execFileSync("python3", ["-c",
    `import json,sys; sys.path.insert(0, ${JSON.stringify(dirname(AGENT))}); import store; ` +
    `print(json.dumps(store.render_transcript(${JSON.stringify(path)}, ${width}, ` +
    `${showAll ? "True" : "False"}, ${ascii ? "True" : "False"})))`,
  ], { encoding: "utf8" });
  return JSON.parse(out) as [string, string][];
}

test("render agrees with store.py across widths and flags", () => {
  const path = fixture();
  for (const width of [40, 60, 100]) {
    for (const showAll of [false, true]) {
      for (const ascii of [false, true]) {
        const expected = pythonRender(path, width, showAll, ascii);
        const actual = renderTranscript(path, width, showAll, ascii);
        assert.deepEqual(actual, expected,
          `render drift at width=${width} showAll=${showAll} ascii=${ascii}`);
      }
    }
  }
});

test("header agrees with store.py", () => {
  const path = fixture();
  const out = execFileSync("python3", ["-c",
    `import json,sys; sys.path.insert(0, ${JSON.stringify(join(REPO, "src", "context_find"))});` +
    `import store; print(json.dumps(store.header(${JSON.stringify(path)})))`,
  ], { encoding: "utf8" });
  assert.deepEqual(header(path), JSON.parse(out));
});

test("scan agrees with store.py on which files match", () => {
  const path = fixture();
  const root = dirname(path);
  for (const query of ["describe-volumes", "EBS", "no-such-text", ""]) {
    const out = execFileSync("python3", ["-c",
      `import json,sys; sys.path.insert(0, ${JSON.stringify(join(REPO, "src", "context_find"))});` +
      `import store; print(json.dumps([s.path for s in store.search_local_transcripts(` +
      `${JSON.stringify(query)}, root=${JSON.stringify(root)})]))`,
    ], { encoding: "utf8" });
    assert.deepEqual(searchLocalTranscripts(query, root).map((s) => s.path), JSON.parse(out),
      `scan drift for query ${JSON.stringify(query)}`);
  }
});

const CODEX_CONVO = [
  { type: "session_meta", timestamp: "2026-08-11T04:09:14Z",
    payload: { session_id: "019fef02-dead-beef", cwd: "/w/proj" } },
  { type: "response_item", timestamp: "2026-08-11T04:09:16Z",
    payload: { type: "message", role: "user",
               content: [{ type: "input_text", text: "# AGENTS.md instructions\nboilerplate" }] } },
  { type: "response_item", timestamp: "2026-08-11T04:09:17Z",
    payload: { type: "message", role: "user",
               content: [{ type: "input_text",
                 text: "kite  login and then check every single account balance we hold" }] } },
  { type: "response_item", timestamp: "2026-08-11T04:09:18Z",
    payload: { type: "message", role: "assistant",
               content: [{ type: "output_text",
                 text: "Opening it now. This line exists to force a wrap at narrow widths." }] } },
  { type: "response_item", timestamp: "2026-08-11T04:09:19Z",
    payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"pwd"}' } },
  { type: "response_item", timestamp: "2026-08-11T04:09:20Z",
    payload: { type: "reasoning", summary: [] } },
];

function codexFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "context-find-golden-codex-"));
  const path = join(dir, "rollout-x.jsonl");
  writeFileSync(path, CODEX_CONVO.map((row) => JSON.stringify(row)).join("\n"), "utf8");
  return path;
}

test("codex render agrees with store.py across widths and flags", () => {
  const path = codexFixture();
  for (const width of [40, 60, 100]) {
    for (const showAll of [false, true]) {
      for (const ascii of [false, true]) {
        assert.deepEqual(renderTranscript(path, width, showAll, ascii),
          pythonRender(path, width, showAll, ascii),
          `codex render drift at width=${width} showAll=${showAll} ascii=${ascii}`);
      }
    }
  }
});

test("codex header agrees with store.py", () => {
  const path = codexFixture();
  const out = execFileSync("python3", ["-c",
    `import json,sys; sys.path.insert(0, ${JSON.stringify(join(REPO, "src", "context_find"))});` +
    `import store; print(json.dumps(store.header(${JSON.stringify(path)})))`,
  ], { encoding: "utf8" });
  assert.deepEqual(header(path), JSON.parse(out));
});

test("relative times agree with store.py", () => {
  const now = 1_800_000_000;
  const gaps = [0, 1, 45, 120, 7200, 172800, 1209600, 7776000, 40000000];
  const out = execFileSync("python3", ["-c",
    `import json,sys; sys.path.insert(0, ${JSON.stringify(join(REPO, "src", "context_find"))});` +
    `import store; print(json.dumps([store.relative_time(0 if g==0 else ${now}-g, now=${now}) ` +
    `for g in ${JSON.stringify(gaps)}]))`,
  ], { encoding: "utf8" });
  assert.deepEqual(gaps.map((g) => relativeTime(g === 0 ? 0 : now - g, now)), JSON.parse(out));
});
