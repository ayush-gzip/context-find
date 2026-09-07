import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { relativeTime, conversationCounts, detectSource, header, renderTranscript, searchLocalTranscripts } from "../src/store.ts";
import { debug } from "../src/debug.ts";
import { appendHostSpec, buildHostSpec, hostDisplayName, readHosts, splitSpecTokens, buildSshArgv,
         readAgentSource as readSourceAgent, buildResumeCommand } from "../src/remote.ts";
import * as remote from "../src/remote.ts";
import { clampScrollTop, sessionRow } from "../src/rows.ts";
import * as rows from "../src/rows.ts";
import { Search } from "../src/search.ts";

const CONVO = [
  { type: "summary" },
  { type: "user", cwd: "/w/proj", gitBranch: "main", timestamp: "2026-08-10T10:00:00Z",
    message: { content: "<command-name>/foo</command-name>" } },
  { type: "user", cwd: "/w/proj", gitBranch: "main", timestamp: "2026-08-10T10:01:00Z",
    message: { content: "fix the EBS scan" } },
  { type: "assistant", timestamp: "2026-08-10T10:02:00Z", message: { content: [
    { type: "text", text: "Looking now." },
    { type: "tool_use", name: "Bash", input: { command: "aws ec2 describe-volumes" } }] } },
];

const TS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_SOURCE = join(TS_ROOT, "..", "src", "context_find", "store.py");
const releaseRemote = await import("../dist/remote.js");

function fixtureRoot(): string {
  const root = join(mkdtempSync(join(tmpdir(), "context-find-")), "projects", "-w-proj");
  mkdirSync(join(root, "subagents"), { recursive: true });
  const body = CONVO.map((row) => JSON.stringify(row)).join("\n");
  writeFileSync(join(root, "a.jsonl"), body, "utf8");
  writeFileSync(join(root, "subagents", "agent-1.jsonl"), body, "utf8");
  return root;
}

test("header skips injected preambles", () => {
  const root = fixtureRoot();
  assert.deepEqual(header(join(root, "a.jsonl"))?.slice(0, 3),
    ["/w/proj", "main", "fix the EBS scan"]);
});

test("scan matches real chat only, not tool calls or preambles, and skips sidechains", () => {
  const root = fixtureRoot();
  assert.equal(searchLocalTranscripts("EBS scan", root).length, 1);          // user turn
  assert.equal(searchLocalTranscripts("Looking now", root).length, 1);       // assistant turn
  assert.equal(searchLocalTranscripts("describe-volumes", root).length, 0);  // tool call - not chat
  assert.equal(searchLocalTranscripts("/foo", root).length, 0);              // injected command wrapper
  assert.equal(searchLocalTranscripts("no-such-text", root).length, 0);
  assert.equal(searchLocalTranscripts("", root).length, 1);
});

test("render hides noise until asked and respects width", () => {
  const path = join(fixtureRoot(), "a.jsonl");
  const text = renderTranscript(path, 60).map(([, line]) => line).join("\n");
  assert.ok(text.includes("You") && text.includes("Claude"));
  assert.ok(text.includes("aws ec2 describe-volumes"));
  assert.ok(!text.includes("/foo"));
  assert.ok(renderTranscript(path, 60).every(([, line]) => line.length <= 60));
  assert.ok(renderTranscript(path, 60, true).map(([, l]) => l).join("\n").includes("/foo"));
});

test("host spec carries ssh options", () => {
  const argv = buildSshArgv("ayush@10.0.0.4 -i ~/.ssh/id_ed25519 -p 2222", "echo hi");
  assert.deepEqual(argv.slice(-2), ["ayush@10.0.0.4", "echo hi"]);
  assert.ok(argv.includes("2222"));
  assert.ok(argv.includes(join(homedir(), ".ssh", "id_ed25519")));
  assert.ok(argv.includes("BatchMode=yes"));

  const interactive = buildSshArgv("mini", "echo hi", { batch: false, tty: true });
  assert.equal(interactive[1], "-t");
  assert.ok(!interactive.includes("BatchMode=yes"));
});

test("host spec splitting handles quotes and display labels", () => {
  assert.deepEqual(splitSpecTokens(`box -o "ProxyCommand=nc gw 22"`),
    ["box", "-o", "ProxyCommand=nc gw 22"]);
  assert.deepEqual(splitSpecTokens("box -i ~/.ssh/key # context-find:os=windows"),
    ["box", "-i", join(homedir(), ".ssh", "key")]);
  assert.deepEqual(splitSpecTokens("box # context-find:os=posix python=/opt/py"),
    ["box"]);
  assert.equal(hostDisplayName("mini -i ~/.ssh/key"), "mini");
  assert.equal(hostDisplayName("ayush@10.0.0.4"), "ayush@10.0.0.4");
});

test("hosts file ignores blank lines", () => {
  const path = join(mkdtempSync(join(tmpdir(), "context-find-hosts-")), "hosts");
  writeFileSync(path, "\n\nmini\nuser@box.local\n", "utf8");
  assert.deepEqual(readHosts(path), ["mini", "user@box.local"]);
  assert.deepEqual(readHosts(join(path, "missing")), []);
});

test("onboarding stores the selected remote OS", () => {
  const build = buildHostSpec as (...args: string[]) => string;
  assert.equal(build("mini", "", "posix"), "mini # context-find:os=posix");
  assert.equal(build("ayush@box", "~/.ssh/key", "windows"),
    "ayush@box -i ~/.ssh/key # context-find:os=windows");
  assert.equal(build("mini", "", "posix", "/opt/py/bin/python3"),
    "mini # context-find:os=posix python=/opt/py/bin/python3");
});

test("onboarding builds a spec and appends it, readable by readHosts", () => {
  assert.equal(buildHostSpec("mini"), "mini # context-find:os=posix");
  assert.equal(buildHostSpec("ayush@box", "~/.ssh/key"),
    "ayush@box -i ~/.ssh/key # context-find:os=posix");

  const path = join(mkdtempSync(join(tmpdir(), "context-find-add-")), "sub", "hosts");
  appendHostSpec(buildHostSpec("mini"), path);                        // creates the dir and file
  appendHostSpec(buildHostSpec("ayush@box", "~/.ssh/key"), path);
  assert.deepEqual(readHosts(path), [
    "mini # context-find:os=posix",
    "ayush@box -i ~/.ssh/key # context-find:os=posix",
  ]);
  assert.equal(hostDisplayName(readHosts(path)[1]!), "ayush@box"); // the -i option is not the label
});

test("agent command uses the stored OS and keeps old hosts POSIX", () => {
  const remoteAgentCommand = (remote as unknown as {
    remoteAgentCommand(spec: string, args: string[]): string;
  }).remoteAgentCommand;
  assert.equal(remoteAgentCommand("mini", ["--conversation-counts"]),
    `"$(command -v python3 || command -v python)" - --args-base64 WyItLWNvbnZlcnNhdGlvbi1jb3VudHMiXQ`);
  assert.equal(remoteAgentCommand("box # context-find:os=windows", ["--conversation-counts"]),
    "py -3 - --args-base64 WyItLWNvbnZlcnNhdGlvbi1jb3VudHMiXQ");
});

test("agent command transports arguments without shell quoting", () => {
  const remoteAgentCommand = (remote as unknown as {
    remoteAgentCommand(spec: string, args: string[]): string;
  }).remoteAgentCommand;
  assert.equal(remoteAgentCommand("box # context-find:os=windows",
    ["--scan", "two words", "100%"]),
  "py -3 - --args-base64 WyItLXNjYW4iLCJ0d28gd29yZHMiLCIxMDAlIl0");
  assert.equal(remoteAgentCommand("box # context-find:os=posix python=/opt/py/bin/python3", ["--conversation-counts"]),
    "/opt/py/bin/python3 - --args-base64 WyItLWNvbnZlcnNhdGlvbi1jb3VudHMiXQ");
});

test("Windows resume command uses encoded PowerShell with literal arguments", () => {
  const command = buildResumeCommand("box # context-find:os=windows", String.raw`C:\O'Brien\app`,
    "session'1", ["codex", "resume"]);
  const encoded = command.match(/^powershell\.exe -NoProfile -EncodedCommand (.+)$/)?.[1];
  assert.ok(encoded);
  assert.equal(Buffer.from(encoded, "base64").toString("utf16le"),
    "Set-Location -LiteralPath 'C:\\O''Brien\\app'\n& 'codex' 'resume' 'session''1'");
});

test("debug logging reads the runtime environment", () => {
  const previous = process.env["CONTEXT_FIND_DEBUG"];
  const write = process.stderr.write;
  let output = "";
  delete process.env["CONTEXT_FIND_DEBUG"];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    debug("hidden");
    assert.equal(output, "");
    process.env["CONTEXT_FIND_DEBUG"] = "1";
    debug("visible");
    assert.equal(output, "[cfind] visible\n");
    output = "";
    debug(`a\nb\tc\u007f${"x".repeat(600)}`);
    assert.equal(output, `[cfind] a b c ${"x".repeat(494)}\n`);
  } finally {
    process.stderr.write = write;
    if (previous === undefined) delete process.env["CONTEXT_FIND_DEBUG"];
    else process.env["CONTEXT_FIND_DEBUG"] = previous;
  }
});

test("remote debug names operations without sensitive arguments", async () => {
  const root = mkdtempSync(join(tmpdir(), "context-find-remote-debug-"));
  const bin = join(root, "bin");
  const key = join(root, "private-key-marker");
  const query = "private-query-marker";
  const transcript = "/private/transcript-path-marker.jsonl";
  mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), "#!/bin/sh\n/bin/cat >/dev/null\nprintf '[]\\n'\n", "utf8");
  chmodSync(join(bin, "ssh"), 0o755);

  const previousDebug = process.env["CONTEXT_FIND_DEBUG"];
  const previousPath = process.env["PATH"];
  const write = process.stderr.write;
  let output = "";
  process.env["CONTEXT_FIND_DEBUG"] = "1";
  process.env["PATH"] = `${bin}:${previousPath ?? ""}`;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.deepEqual(await releaseRemote.searchRemoteTranscripts(`safe-host -i ${key}`, query), []);
    assert.deepEqual(await releaseRemote.renderRemoteTranscript(`safe-host -i ${key}`, transcript, 80, false, false), []);

    assert.match(output, /safe-host: remote scan started/);
    assert.match(output, /safe-host: remote scan finished/);
    assert.match(output, /safe-host: remote render started/);
    assert.match(output, /safe-host: remote render finished/);
    for (const sensitive of [query, transcript, key, dirname(TS_ROOT),
                             "BatchMode=yes", "--args-base64"]) {
      assert.ok(!output.includes(sensitive), `debug output leaked ${sensitive}`);
    }
  } finally {
    process.stderr.write = write;
    if (previousDebug === undefined) delete process.env["CONTEXT_FIND_DEBUG"];
    else process.env["CONTEXT_FIND_DEBUG"] = previousDebug;
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
  }
});

test("local search debug reports counts without query, path, or content", async () => {
  const root = fixtureRoot();
  const config = dirname(dirname(root));
  const query = "EBS";
  const previousDebug = process.env["CONTEXT_FIND_DEBUG"];
  const previousClaude = process.env["CLAUDE_CONFIG_DIR"];
  const previousCodex = process.env["CODEX_HOME"];
  const previousHome = process.env["HOME"];
  const write = process.stderr.write;
  let output = "";
  process.env["CONTEXT_FIND_DEBUG"] = "1";
  process.env["CLAUDE_CONFIG_DIR"] = config;
  process.env["CODEX_HOME"] = join(config, "no-codex-store");
  process.env["HOME"] = config;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const search = new Search(query);
    await search.wait();
    assert.equal(search.sessions.length, 1);
    assert.match(output, /local scan completed: 1 candidates, 1 matched/);
    assert.match(output, /search started: 1 local results, 0 remote hosts/);
    assert.match(output, /remote searches completed: 0 succeeded, 0 failed/);
    for (const sensitive of [query, root, "aws ec2 describe-volumes", "fix the EBS scan"]) {
      assert.ok(!output.includes(sensitive), `debug output leaked ${sensitive}`);
    }
  } finally {
    process.stderr.write = write;
    for (const [name, value] of [
      ["CONTEXT_FIND_DEBUG", previousDebug], ["CLAUDE_CONFIG_DIR", previousClaude],
      ["CODEX_HOME", previousCodex], ["HOME", previousHome],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("local scan debug separates skipped files from errors", () => {
  const root = fixtureRoot();
  writeFileSync(join(root, "not-a-match.jsonl"),
    CONVO.map((row) => JSON.stringify(row)).join("\n").replace("EBS", "other"),
    "utf8");
  symlinkSync(join(root, "missing.jsonl"), join(root, "unreadable.jsonl"));
  const previous = process.env["CONTEXT_FIND_DEBUG"];
  const write = process.stderr.write;
  let output = "";
  process.env["CONTEXT_FIND_DEBUG"] = "1";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.equal(searchLocalTranscripts("EBS", root).length, 1);
    const summary = output.match(
      /local scan completed: (\d+) candidates, (\d+) matched, (\d+) skipped, (\d+) errors/,
    );
    assert.ok(summary);
    const [candidates, matched, skipped, errors] = summary.slice(1).map(Number);
    assert.deepEqual([candidates, matched, skipped, errors], [3, 1, 1, 1]);
    assert.equal(candidates, matched + skipped + errors);
  } finally {
    process.stderr.write = write;
    if (previous === undefined) delete process.env["CONTEXT_FIND_DEBUG"];
    else process.env["CONTEXT_FIND_DEBUG"] = previous;
  }
});

test("CLI help describes application diagnostics", () => {
  const buildRoot = mkdtempSync(join(tmpdir(), "context-find-cli-debug-"));
  const outDir = join(buildRoot, "dist");
  symlinkSync(join(TS_ROOT, "node_modules"), join(buildRoot, "node_modules"), "dir");
  const build = spawnSync(join(TS_ROOT, "node_modules", ".bin", "tsc"),
    ["--outDir", outDir], { cwd: TS_ROOT, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);

  const help = spawnSync(process.execPath, [join(outDir, "cli.js"), "--help"],
    { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--debug\s+print application diagnostics to stderr/);
});

test("python agent decodes transported arguments", () => {
  const path = join(fixtureRoot(), "a.jsonl");
  const args = ["--render", path, "60", "0", "0"];
  const encoded = Buffer.from(JSON.stringify(args)).toString("base64url");
  const done = spawnSync("python3", ["-", "--args-base64", encoded], {
    input: readFileSync(AGENT_SOURCE, "utf8"), encoding: "utf8",
  });
  assert.equal(done.status, 0, done.stderr);
  assert.ok(JSON.parse(done.stdout).some((line: string[]) => line[1].includes("fix the EBS scan")));
});

test("source modules do not fall back to the repository agent asset", () => {
  assert.throws(() => readSourceAgent(), /cannot find store\.py/);
});

test("scroll keeps the cursor in view", () => {
  assert.equal(clampScrollTop(0, 0, 10), 0);
  assert.equal(clampScrollTop(0, 25, 10), 16);
  assert.equal(clampScrollTop(20, 3, 10), 3);
});

test("vertical motion accepts Vim keys and arrow keys", () => {
  const verticalMotion = (rows as unknown as {
    verticalMotion(input: string, key: { upArrow: boolean; downArrow: boolean; ctrl?: boolean }): number;
  }).verticalMotion;
  assert.equal(verticalMotion("j", { upArrow: false, downArrow: false }), 1);
  assert.equal(verticalMotion("k", { upArrow: false, downArrow: false }), -1);
  assert.equal(verticalMotion("j", { upArrow: false, downArrow: false, ctrl: true }), 1);
  assert.equal(verticalMotion("k", { upArrow: false, downArrow: false, ctrl: true }), -1);
  assert.equal(verticalMotion("", { upArrow: true, downArrow: false }), -1);
  assert.equal(verticalMotion("", { upArrow: false, downArrow: true }), 1);
});

test("conversation header aligns every visible column", () => {
  const tableHeader = (rows as unknown as { tableHeader(width: number): string }).tableHeader;
  const line = tableHeader(100);
  assert.equal(line.indexOf("DATE"), 0);
  assert.equal(line.indexOf("AGENT"), 14);
  assert.equal(line.indexOf("MACHINE"), 21);
  assert.equal(line.indexOf("DIR"), 32);
  assert.equal(line.indexOf("BRANCH"), 57);
  assert.equal(line.indexOf("PREVIEW"), 67);
  assert.ok(tableHeader(80).includes("PREVIEW"));
});

test("normal and search modes keep Vim shortcuts separate from filter text", () => {
  const listAction = (rows as unknown as {
    listAction(input: string, key: object, searching: boolean): string;
  }).listAction;
  assert.equal(listAction("j", {}, false), "down");
  assert.equal(listAction("k", {}, false), "up");
  assert.equal(listAction("l", {}, false), "list-machines");
  assert.equal(listAction("/", {}, false), "search");
  assert.equal(listAction("v", {}, false), "view");
  assert.equal(listAction("r", {}, false), "resume");
  assert.equal(listAction("", { return: true }, false), "resume");
  assert.equal(listAction("", { return: true }, true), "resume");
  assert.equal(listAction("", { tab: true }, true), "view");
  assert.equal(listAction("", { escape: true }, false), "quit");
  assert.equal(listAction("j", {}, true), "type");
  assert.equal(listAction("j", { ctrl: true }, true), "down");
  assert.equal(listAction("k", { ctrl: true }, true), "up");
  assert.equal(listAction("j", { ctrl: true }, false), "down");
  assert.equal(listAction("k", { ctrl: true }, false), "up");
  assert.equal(listAction("l", {}, true), "type");
  assert.equal(listAction("v", {}, true), "type");
  assert.equal(listAction("", { escape: true }, true), "normal");
  // Ctrl+D is deep search in either mode; a plain "d" while typing stays filter text
  assert.equal(listAction("d", { ctrl: true }, false), "deep");
  assert.equal(listAction("d", { ctrl: true }, true), "deep");
  assert.equal(listAction("d", {}, true), "type");
});

test("machine rows show counts and unavailable states", () => {
  const machineRow = (rows as unknown as {
    machineRow(name: string, tally: Record<string, number> | null, status: string): string[];
  }).machineRow;
  assert.deepEqual(machineRow("mini", { claude: 2, codex: 3 }, "ready in 0.2s"),
    ["mini", "2", "3", "5", "never", "ready in 0.2s"]);
  assert.deepEqual(machineRow("box", null, "unreachable"),
    ["box", "-", "-", "-", "-", "unreachable"]);
});

test("machine table keeps a gap between every column", () => {
  const machineLine = (rows as unknown as {
    machineLine(cells: string[], width: number): string;
  }).machineLine;
  const line = machineLine(["box", "2", "3", "5", "never", "ready"], 80);
  assert.match(line, /\s5\s+never\s+ready$/);
});

test("row text truncates long paths from the left and long branches from the right", () => {
  const cell = sessionRow({
    path: "/x/a.jsonl", cwd: "/very/deep/nested/path/that/keeps/going/onwards/forever",
    branch: "feat/a-very-long-branch-name", summary: "hi", mtime: 1_760_000_000,
    host: null, source: "codex",
  });
  assert.ok(cell.folder.startsWith("…"));
  assert.equal(cell.folder.length, 24);
  assert.ok(cell.branch.endsWith("…"));
  assert.equal(cell.branch.length, 9);
  assert.equal(cell.host, "local");
});

test("search returns local rows before an unreachable host resolves", async () => {
  const root = fixtureRoot();
  const search = new Search("", [], () => {});
  await search.wait();
  assert.equal(search.pending.length, 0);

  const local = searchLocalTranscripts("", root);
  assert.equal(local.length, 1);
});


const CODEX = [
  { type: "session_meta", timestamp: "2026-08-11T04:09:14Z",
    payload: { session_id: "019fef02-dead-beef", cwd: "/w/proj" } },
  { type: "response_item", timestamp: "2026-08-11T04:09:16Z",
    payload: { type: "message", role: "user",
               content: [{ type: "input_text", text: "# AGENTS.md instructions\nboilerplate" }] } },
  { type: "response_item", timestamp: "2026-08-11T04:09:17Z",
    payload: { type: "message", role: "user",
               content: [{ type: "input_text", text: "kite login" }] } },
  { type: "response_item", timestamp: "2026-08-11T04:09:18Z",
    payload: { type: "message", role: "assistant",
               content: [{ type: "output_text", text: "Opening it now." }] } },
  { type: "response_item", timestamp: "2026-08-11T04:09:19Z",
    payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"pwd"}' } },
  { type: "response_item", timestamp: "2026-08-11T04:09:20Z",
    payload: { type: "reasoning", summary: [] } },
];

function codexFixture(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "context-find-codex-")),
                   "sessions", "2026", "08", "11");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "rollout-x.jsonl");
  writeFileSync(path, CODEX.map((row) => JSON.stringify(row)).join("\n"), "utf8");
  return path;
}

test("codex header skips the AGENTS.md preamble and reads the session id", () => {
  const path = codexFixture();
  assert.equal(detectSource(path), "codex");
  assert.deepEqual(header(path), ["/w/proj", "-", "kite login", "019fef02-dead-beef"]);
});

test("codex render shows turns, hides reasoning until asked", () => {
  const path = codexFixture();
  const text = renderTranscript(path, 60).map(([, line]) => line).join("\n");
  assert.ok(text.includes("You") && text.includes("Codex"));
  assert.ok(text.includes("kite login") && text.includes("Opening it now."));
  assert.ok(text.includes("exec_command"));
  assert.ok(!text.includes("AGENTS.md"));
  assert.ok(!text.includes("reasoning"));
  assert.ok(renderTranscript(path, 60).every(([, line]) => line.length <= 60));

  const verbose = renderTranscript(path, 60, true).map(([, l]) => l).join("\n");
  assert.ok(verbose.includes("reasoning") && verbose.includes("AGENTS.md"));
});

test("source filter selects which agents are scanned", () => {
  const codexPath = codexFixture();
  const codexHome = join(codexPath, "..", "..", "..", "..", "..");
  const claudeHome = mkdtempSync(join(tmpdir(), "context-find-claude-"));
  const claudeRoot = join(claudeHome, "projects", "-w-proj");
  mkdirSync(claudeRoot, { recursive: true });
  writeFileSync(join(claudeRoot, "a.jsonl"),
    CONVO.map((row) => JSON.stringify(row)).join("\n"), "utf8");

  const savedHome = process.env["HOME"];
  process.env["HOME"] = claudeHome;          // else projects_roots also finds the real ~/.claude
  process.env["CLAUDE_CONFIG_DIR"] = claudeHome;
  process.env["CODEX_HOME"] = codexHome;
  try {
    const tally = conversationCounts();
    assert.equal(tally["claude"], 1);
    assert.equal(tally["codex"], 1);
    assert.ok(tally["last"]! > 0);
    // one pass reads both agents; --claude / --codex filter the finished list
    const all = searchLocalTranscripts("");
    assert.equal(all.length, 2);
    assert.deepEqual(all.filter((s) => s.source === "codex").map((s) => s.source), ["codex"]);
    assert.deepEqual(all.filter((s) => s.source === "claude").map((s) => s.source), ["claude"]);
  } finally {
    delete process.env["CLAUDE_CONFIG_DIR"];
    delete process.env["CODEX_HOME"];
    if (savedHome) process.env["HOME"] = savedHome;
  }
});


test("ago reads naturally at every scale", () => {
  const now = 1_800_000_000;
  const cases: [number, string][] = [
    [0, "never"], [1, "1 second ago"], [45, "45 seconds ago"],
    [120, "2 minutes ago"], [7200, "2 hours ago"], [172800, "2 days ago"],
    [1209600, "2 weeks ago"], [7776000, "3 months ago"],
  ];
  for (const [gap, expected] of cases) {
    assert.equal(relativeTime(gap === 0 ? 0 : now - gap, now), expected, String(gap));
  }
});
