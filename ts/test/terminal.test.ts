import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { machineRow, printTerminalError } from "../src/terminal.ts";

const escape = "\x1b]52;c;VEVTVA==\x07";

test("machine rows sanitize names and states", () => {
  assert.deepEqual(machineRow("box" + escape, null, "offline" + escape),
    ["box", "-", "-", "-", "-", "offline"]);
});

test("the CLI no longer searches: a query or a search flag points to the dashboard", () => {
  const root = mkdtempSync(join(tmpdir(), "cfind-terminal-"));
  try {
    const run = (args: string[]) => spawnSync(process.execPath, ["dist/cli.js", ...args],
      { encoding: "utf8", env: { ...process.env, HOME: root, USERPROFILE: root } });
    const query = run(["ebs"]);
    assert.equal(query.status, 1);
    assert.match(query.stderr, /no longer searches in the terminal.*dashboard/);
    const json = run(["--json"]);
    assert.equal(json.status, 1);
    assert.match(json.stderr, /--json/);
    assert.equal(run(["--help"]).status, 0);
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
