import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaudeProfile, recordSignal } from "../src/collector.ts";

test("Claude setup preserves existing settings and is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-setup-"));
  try {
    const profile = join(dir, "claude");
    mkdirSync(profile);
    const original = {
      theme: "dark",
      statusLine: { type: "command", command: "printf existing", padding: 2 },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo prior" }] }],
      },
    };
    writeFileSync(join(profile, "settings.json"), JSON.stringify(original));
    installClaudeProfile(profile, "personal", dir);
    installClaudeProfile(profile, "personal", dir);
    const settings = JSON.parse(
      readFileSync(join(profile, "settings.json"), "utf8"),
    );
    assert.equal(settings.theme, "dark");
    assert.equal(settings.statusLine.padding, 2);
    assert.equal(settings.hooks.Stop.length, 2);
    assert.equal(settings.hooks.Stop[0].hooks[0].command, "echo prior");
    assert.equal(
      JSON.parse(
        readFileSync(join(profile, "settings.json.cfind-backup"), "utf8"),
      ).statusLine.command,
      "printf existing",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("signals contain state and identifiers without copying prompt text", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-signals-"));
  try {
    recordSignal(
      "personal",
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "a",
        cwd: "/project",
        prompt: "private secret",
      },
      dir,
    );
    const file = readdirSync(join(dir, "signals"))[0]!;
    const signal = JSON.parse(readFileSync(join(dir, "signals", file), "utf8"));
    assert.equal(signal.state, "running");
    assert.equal(signal.sessionId, "a");
    assert.ok(!JSON.stringify(signal).includes("private secret"));
    recordSignal("personal", { hook_event_name: "Stop", session_id: "a" }, dir);
    assert.equal(
      JSON.parse(readFileSync(join(dir, "signals", file), "utf8")).state,
      "idle",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
