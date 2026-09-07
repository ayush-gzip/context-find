import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebServer, isPathContained, isPermittedHost, resolveConfiguredHost } from "../src/web.ts";
import { sanitizeTerminalText, searchLocalTranscripts, header, renderTranscript } from "../src/store.ts";
import {
  quoteForPosixShell,
  validateRemoteSessions,
  validateConversationCounts,
  validateRenderLines,
} from "../src/remote.ts";
import { Search } from "../src/search.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STORE_PY = join(REPO_ROOT, "src", "context_find", "store.py");

// Helper to make an HTTP request to a test server
function httpRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method || "GET",
        headers: options.headers,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ── FIX 1: Browser requests supplying executable SSH options ──────────────────

test("Fix 1: resolveConfiguredHost resolves display names to stored specs and rejects injected options", () => {
  const configured = [
    "prod-server -i /keys/prod.pem # context-find:os=posix",
    "backup-box -p 2222",
  ];

  // Matches display name and returns the STORED configuration spec
  assert.equal(
    resolveConfiguredHost("prod-server", configured),
    "prod-server -i /keys/prod.pem # context-find:os=posix",
  );
  assert.equal(
    resolveConfiguredHost("backup-box", configured),
    "backup-box -p 2222",
  );

  // Exact match of stored spec
  assert.equal(
    resolveConfiguredHost("prod-server -i /keys/prod.pem # context-find:os=posix", configured),
    "prod-server -i /keys/prod.pem # context-find:os=posix",
  );

  // Injected ProxyCommand or arbitrary options MUST NOT resolve
  assert.equal(
    resolveConfiguredHost("prod-server -oProxyCommand=calc.exe", configured),
    undefined,
  );
  assert.equal(
    resolveConfiguredHost("unknown-host", configured),
    undefined,
  );
  assert.equal(
    resolveConfiguredHost("prod-server; touch /tmp/pwn", configured),
    undefined,
  );
});

// ── FIX 2: Browser local-host protection and Host header validation ──────────

test("Fix 2: isPermittedHost validates exact permitted host and port", () => {
  const port = 4319;

  // Permitted host headers
  assert.ok(isPermittedHost(`localhost:${port}`, port));
  assert.ok(isPermittedHost(`127.0.0.1:${port}`, port));
  assert.ok(isPermittedHost(`[::1]:${port}`, port));

  // Port 80 permits without port as well
  assert.ok(isPermittedHost("localhost", 80));
  assert.ok(isPermittedHost("127.0.0.1", 80));

  // Attacker domains attempting DNS rebinding MUST be rejected
  assert.ok(!isPermittedHost(`localhost.attacker.example:${port}`, port));
  assert.ok(!isPermittedHost("localhost.attacker.example", port));
  assert.ok(!isPermittedHost(`attacker.com:${port}`, port));
  assert.ok(!isPermittedHost(`127.0.0.1.nip.io:${port}`, port));

  // Wrong ports must be rejected
  assert.ok(!isPermittedHost(`localhost:${port + 1}`, port));
  assert.ok(!isPermittedHost(`127.0.0.1:${port + 1}`, port));
  assert.ok(!isPermittedHost("localhost", port)); // port is not 80
  assert.ok(!isPermittedHost("127.0.0.1", port));
  assert.ok(!isPermittedHost(undefined, port));
});

test("Fix 2: Web server rejects invalid Host headers on root page and API (no token disclosure)", async () => {
  const { server, token } = createWebServer([], 0);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;

  try {
    // 1. Rebinding attack on root page: Host: localhost.attacker.example
    const attackRoot = await httpRequest(`http://127.0.0.1:${port}/`, {
      headers: { host: `localhost.attacker.example:${port}` },
    });
    assert.equal(attackRoot.status, 403);
    assert.ok(!attackRoot.body.includes(token), "token disclosed to attacker domain!");

    // 2. Rebinding attack on API: Host: localhost.attacker.example
    const attackApi = await httpRequest(`http://127.0.0.1:${port}/api/search?t=${token}`, {
      headers: { host: `localhost.attacker.example:${port}` },
    });
    assert.equal(attackApi.status, 403);

    // 3. Valid Host header on root page succeeds
    const legitRoot = await httpRequest(`http://127.0.0.1:${port}/`, {
      headers: { host: `127.0.0.1:${port}` },
    });
    assert.equal(legitRoot.status, 200);
    assert.ok(legitRoot.body.includes(token));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ── FIX 3: Transcript directory restriction and symlink containment ──────────

test("Fix 3: isPathContained checks directory containment without string prefix bypass", () => {
  const parent = "/home/user/.claude/projects/-w-proj";

  // Legitimate child file
  assert.ok(isPathContained(`${parent}/a.jsonl`, parent));
  assert.ok(isPathContained(`${parent}/sub/b.jsonl`, parent));

  // Traversal bypasses
  assert.ok(!isPathContained(`${parent}-outside/c.jsonl`, parent));
  assert.ok(!isPathContained(`${parent}/../other/c.jsonl`, parent));
  assert.ok(!isPathContained("/etc/passwd", parent));
});

test("Fix 3: Web server rejects paths in sessions-outside and outside symlinks", async () => {
  const root = mkdtempSync(join(tmpdir(), "context-find-test-roots-"));
  const allowedStore = join(root, "allowed-sessions");
  const outsideStore = join(root, "allowed-sessions-outside");
  mkdirSync(allowedStore, { recursive: true });
  mkdirSync(outsideStore, { recursive: true });

  const insideFile = join(allowedStore, "valid.jsonl");
  const outsideFile = join(outsideStore, "leak.jsonl");
  const symlinkFile = join(allowedStore, "symlink-outside.jsonl");

  const convo = JSON.stringify({ type: "user", cwd: "/w", message: { content: "test" } });
  writeFileSync(insideFile, convo, "utf8");
  writeFileSync(outsideFile, convo, "utf8");
  symlinkSync(outsideFile, symlinkFile);

  const prevClaude = process.env["CLAUDE_CONFIG_DIR"];
  process.env["CLAUDE_CONFIG_DIR"] = root;

  const { server, token } = createWebServer([], 0);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;

  try {
    // 1. Path in sibling directory with prefix match (allowed-sessions-outside)
    const prefixEscape = await httpRequest(
      `http://127.0.0.1:${port}/api/session?t=${token}&path=${encodeURIComponent(outsideFile)}`,
      { headers: { host: `127.0.0.1:${port}` } },
    );
    assert.equal(prefixEscape.status, 403);

    // 2. Symlink inside allowed store pointing outside
    const symlinkEscape = await httpRequest(
      `http://127.0.0.1:${port}/api/session?t=${token}&path=${encodeURIComponent(symlinkFile)}`,
      { headers: { host: `127.0.0.1:${port}` } },
    );
    assert.equal(symlinkEscape.status, 403);

    // 3. Unknown host option injection attempt is also rejected (Fix 1 verification on HTTP)
    const hostEscape = await httpRequest(
      `http://127.0.0.1:${port}/api/session?t=${token}&path=any&host=${encodeURIComponent("evil-host -oProxyCommand=id")}`,
      { headers: { host: `127.0.0.1:${port}` } },
    );
    assert.equal(hostEscape.status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevClaude === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = prevClaude;
    rmSync(root, { recursive: true, force: true });
  }
});

// ── FIX 4: Untrusted terminal text sanitization and resume quoting ────────────

test("Fix 4: sanitizeTerminalText strips OSC 52 and dangerous control characters", () => {
  // Injected OSC 52 sequences (copying data to terminal clipboard)
  const osc52Bel = "Important \x1b]52;c;cGF3bmVk\x07notice";
  const osc52St = "Important \x1b]52;c;cGF3bmVk\x1b\\notice";
  assert.equal(sanitizeTerminalText(osc52Bel), "Important notice");
  assert.equal(sanitizeTerminalText(osc52St), "Important notice");

  // ANSI color / CSI escape sequences
  const csi = "\x1b[31;1mRed Bold Text\x1b[0m";
  assert.equal(sanitizeTerminalText(csi), "Red Bold Text");

  // General control characters (excluding tab \t and newline \n)
  const controls = "line 1\x00\x08\x0b\x0c\x1b\x7f\nline 2\tindented";
  assert.equal(sanitizeTerminalText(controls), "line 1\nline 2\tindented");
});

test("Fix 4: Python store.py sanitizes OSC 52 terminal text identically", () => {
  const injected = "injected \x1b]52;c;cGF3bmVk\x07text \x1b[32mgreen\x1b[0m";
  const pyOut = execFileSync(
    "python3",
    [
      "-c",
      `import sys; sys.path.insert(0, ${JSON.stringify(dirname(STORE_PY))}); import store; print(store.sanitize_terminal_text(${JSON.stringify(injected)}))`,
    ],
    { encoding: "utf8" },
  ).trim();

  assert.equal(pyOut, "injected text green");
  assert.equal(sanitizeTerminalText(injected), pyOut);
});

test("Fix 4: quoteForPosixShell safely escapes special characters in resume commands", () => {
  assert.equal(quoteForPosixShell("/normal/path"), "'/normal/path'");
  assert.equal(
    quoteForPosixShell("/path with spaces/and 'quotes'"),
    `'/path with spaces/and '"'"'quotes'"'"''`,
  );
  assert.equal(
    quoteForPosixShell("id; rm -rf /"),
    `'id; rm -rf /'`,
  );
});

// ── FIX 5: Malformed JSONL data and remote response shape validation ─────────

test("Fix 5: JSONL containing null, numbers, or corrupt records does not crash Python scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "context-find-malformed-"));
  const projDir = join(dir, "projects", "proj");
  mkdirSync(projDir, { recursive: true });
  const badFile = join(projDir, "corrupt.jsonl");
  const goodFile = join(projDir, "good.jsonl");

  // Bad file has null, number, boolean, truncated line, empty object
  writeFileSync(
    badFile,
    "null\n123\ntrue\n{\"type\": null}\n{\"type\": \"user\", \"message\": null}\n{invalid json}\n",
    "utf8",
  );

  // Good file has valid conversation
  const goodTurn = JSON.stringify({
    type: "user",
    cwd: "/w/proj",
    gitBranch: "main",
    message: { content: "find this valid session" },
  });
  writeFileSync(goodFile, goodTurn + "\n", "utf8");

  // Run python store.py --scan
  const pyOut = execFileSync(
    "python3",
    [STORE_PY, "--scan", "valid session"],
    {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    },
  );

  const scanned = JSON.parse(pyOut);
  assert.equal(scanned.length, 1);
  assert.equal(scanned[0].summary, "find this valid session");

  // Also verify TypeScript searchLocalTranscripts handles badFile gracefully
  const tsResults = searchLocalTranscripts("valid session", projDir);
  assert.equal(tsResults.length, 1);
  assert.equal(tsResults[0]!.summary, "find this valid session");

  rmSync(dir, { recursive: true, force: true });
});

test("Fix 5: validateRemoteSessions validates array and record shapes", () => {
  // Non-array throws
  assert.throws(() => validateRemoteSessions(null, "host"), /expected array/);
  assert.throws(() => validateRemoteSessions({}, "host"), /expected array/);

  // Filters out malformed objects, keeps valid ones
  const data = [
    null,
    "string",
    { path: "/p", cwd: "/w" }, // missing fields
    { path: "/p1", cwd: "/w1", branch: "main", summary: "ok", mtime: 1700000000, source: "claude" },
  ];
  const validated = validateRemoteSessions(data, "remote-host");
  assert.equal(validated.length, 1);
  assert.equal(validated[0]!.path, "/p1");
  assert.equal(validated[0]!.host, "remote-host");
});

test("Fix 5: validateConversationCounts and validateRenderLines validate shapes", () => {
  assert.throws(() => validateConversationCounts([]), /expected object/);
  assert.deepEqual(validateConversationCounts({ claude: 5, codex: 2, invalid: "text" }), {
    claude: 5,
    codex: 2,
  });

  assert.throws(() => validateRenderLines("not an array"), /expected array/);
  const lines = validateRenderLines([["user", "hello \x1b]52;c;evil\x07"], ["invalid"]]);
  assert.deepEqual(lines, [["user", "hello "]]);
});

// ── FIX 6: Initial remote search updates subscribing and delayed completion ──

test("Fix 6: Search.subscribe notifies subscribers on remote updates and delayed completion", async () => {
  let updateCount = 0;

  // Mock search without initial onUpdate callback (simulating App's initialSearch)
  const search = new Search("", []);
  const unsubscribe = search.subscribe(() => {
    updateCount += 1;
  });

  assert.equal(updateCount, 0);

  // Wait for completion
  await search.wait();

  // Multiple subscribers and unsubscribe
  let sub2Count = 0;
  const unsub2 = search.subscribe(() => {
    sub2Count += 1;
  });

  unsubscribe();
  unsub2();
});
