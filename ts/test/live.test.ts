import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  capturePane,
  codexHolder,
  procStart,
  queueCodex,
  sendKey,
  sendToPane,
  takeOver,
} from "../src/live.ts";

const dir = mkdtempSync(join(tmpdir(), "cfind-live-")),
  log = join(dir, "tmux.log"),
  tmux = join(dir, "tmux");
writeFileSync(
  tmux,
  `#!/bin/sh
echo "$@" >> "$FAKE_TMUX_LOG"
case "$1" in
  display-message) echo "$FAKE_PANE_PID" ;;
  load-buffer) cat >> "$FAKE_TMUX_LOG"; echo >> "$FAKE_TMUX_LOG" ;;
  capture-pane) printf ' Select model\n \\033]52;c;eA==\\007> 1. Opus\n   2. Sonnet\n\n' ;;
esac
`,
);
chmodSync(tmux, 0o755);
process.env["CFIND_TMUX_BIN"] = tmux;
process.env["FAKE_TMUX_LOG"] = log;
test.after(() => rmSync(dir, { recursive: true, force: true }));

const record = (over = {}) => ({
  profile: "claude",
  sessionId: "s1",
  pid: process.pid,
  procStart: procStart(process.pid),
  tmux: "%7",
  status: "idle",
  updatedAt: 0,
  ...over,
});
const calls = () => {
  try {
    return readFileSync(log, "utf8");
  } catch {
    return "";
  }
};

test("send pastes into the pane that runs the process, then presses Enter", async () => {
  writeFileSync(log, "");
  process.env["FAKE_PANE_PID"] = String(process.ppid);
  await sendToPane(record(), "fix it\n\x1b[201~now");
  const lines = calls().split("\n");
  assert.equal(lines[0], "display-message -p -t %7 #{pane_pid}");
  assert.match(lines[1]!, /^load-buffer -b cfind-[0-9a-f]{8} -$/);
  assert.equal(lines[2], "fix it");
  assert.equal(lines[3], "[201~now");
  assert.match(calls(), /paste-buffer -d -p -r -b cfind-[0-9a-f]{8} -t %7/);
  assert.match(calls(), /send-keys -t %7 Enter\n$/);
});

test("send works while busy, but not into a menu or a different process", async () => {
  process.env["FAKE_PANE_PID"] = String(process.ppid);
  writeFileSync(log, "");
  await sendToPane(record({ status: "busy" }), "steer");
  assert.match(calls(), /send-keys -t %7 Enter/);
  writeFileSync(log, "");
  await sendToPane(record({ status: "shell" }), "after the scans");
  assert.match(calls(), /send-keys -t %7 Enter/);
  for (const [over, error] of [
    [{ status: "waiting" }, /waiting for an answer/],
    [{ procStart: "Mon Jan 1 00:00:00 2001" }, /Could not confirm/],
    [{ tmux: "" }, /not in tmux/],
  ] as const) {
    writeFileSync(log, "");
    await assert.rejects(sendToPane(record(over), "x"), error);
    assert.equal(calls(), "");
  }
  writeFileSync(log, "");
  process.env["FAKE_PANE_PID"] = "999999";
  await assert.rejects(sendToPane(record(), "x"), /no longer runs/);
  assert.doesNotMatch(calls(), /load-buffer|send-keys/);
});

test("a menu that opens during the paste stops the Enter", async () => {
  process.env["FAKE_PANE_PID"] = String(process.ppid);
  writeFileSync(log, "");
  let reads = 0;
  await assert.rejects(
    sendToPane(record(), "x", () =>
      record({ status: ++reads > 1 ? "waiting" : "busy" }),
    ),
    /in its input box but was not sent/,
  );
  assert.match(calls(), /paste-buffer/);
  assert.doesNotMatch(calls(), /send-keys/);
});

test("the menu screen and its keys work while the session waits", () => {
  process.env["FAKE_PANE_PID"] = String(process.ppid);
  writeFileSync(log, "");
  const waiting = record({ status: "waiting" });
  assert.equal(
    capturePane(waiting),
    "Select model\n ]52;c;eA==> 1. Opus\n   2. Sonnet",
  );
  assert.match(calls(), /capture-pane -p -t %7\n$/);
  sendKey(waiting, "Down");
  sendKey(waiting, "2");
  sendKey(waiting, "s");
  assert.deepEqual(calls().match(/send-keys .*/g), [
    "send-keys -t %7 Down",
    "send-keys -t %7 2",
    "send-keys -t %7 s",
  ]);
  for (const key of ["C-c", "S", "ab", "0", "Enter Enter", "rm -rf ~"])
    assert.throws(() => sendKey(waiting, key), /Unknown key/);
  for (const [over, error] of [
    [{ procStart: "Mon Jan 1 00:00:00 2001" }, /Could not confirm/],
    [{ tmux: "" }, /not in tmux/],
  ] as const) {
    writeFileSync(log, "");
    assert.throws(() => sendKey(record(over), "Enter"), error);
    assert.throws(() => capturePane(record(over)), error);
    assert.equal(calls(), "");
  }
  process.env["FAKE_PANE_PID"] = "999999";
  writeFileSync(log, "");
  assert.throws(() => sendKey(waiting, "Enter"), /no longer runs/);
  assert.throws(() => capturePane(waiting), /no longer runs/);
  assert.doesNotMatch(calls(), /capture-pane|send-keys/);
});

test("take over stops only a verified process outside tmux", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const exited = new Promise((r) => child.once("exit", r));
  await new Promise((r) => setTimeout(r, 200));
  const r = record({ pid: child.pid!, procStart: procStart(child.pid!) });
  try {
    await assert.rejects(takeOver(r), /in tmux/);
    await assert.rejects(
      takeOver({ ...r, tmux: "", procStart: "Mon Jan 1 00:00:00 2001" }),
      /Could not confirm/,
    );
    process.kill(child.pid!, 0);
    await takeOver({ ...r, tmux: "" });
    assert.equal(await exited, null);
  } finally {
    child.kill("SIGKILL");
  }
});

test("a Codex session goes to the helper only when the helper has its file open", async () => {
  const lsof = join(dir, "lsof"),
    codex = join(dir, "codex");
  writeFileSync(
    lsof,
    `#!/bin/sh
[ -n "$FAKE_LSOF_PIDS" ] || exit 1
echo "$FAKE_LSOF_PIDS"
`,
  );
  writeFileSync(codex, `#!/bin/sh\nprintf '%s|' "$@" >> "$FAKE_TMUX_LOG"\n`);
  chmodSync(lsof, 0o755);
  chmodSync(codex, 0o755);
  process.env["CFIND_LSOF_BIN"] = lsof;
  process.env["CFIND_CODEX_BIN"] = codex;
  const keep = ["-e", "setInterval(() => {}, 1000)"],
    helper = spawn(process.execPath, [
      ...keep,
      "app-server",
      "--listen",
      "unix://",
    ]),
    other = spawn(process.execPath, [
      ...keep,
      "app-server",
      "--listen",
      "stdio://",
    ]);
  await new Promise((r) => setTimeout(r, 200));
  try {
    process.env["FAKE_LSOF_PIDS"] = "";
    assert.equal(codexHolder("/x.jsonl"), "none");
    process.env["FAKE_LSOF_PIDS"] = `${other.pid}`;
    assert.equal(codexHolder("/x.jsonl"), "other");
    process.env["FAKE_LSOF_PIDS"] = `${other.pid}\n${helper.pid}`;
    assert.equal(codexHolder("/x.jsonl"), "helper");
    process.env["CFIND_LSOF_BIN"] = join(dir, "missing");
    assert.throws(() => codexHolder("/x.jsonl"), /Could not check/);
    writeFileSync(log, "");
    queueCodex("t1", "two\nlines\0");
    assert.equal(calls(), "queue|--thread|t1|--message|two\nlines|");
  } finally {
    helper.kill("SIGKILL");
    other.kill("SIGKILL");
  }
});
