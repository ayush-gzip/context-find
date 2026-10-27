import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebServer } from "../src/web.ts";
import { Devices } from "../src/devices.ts";

async function serve() {
  const home = mkdtempSync(join(tmpdir(), "cfind-devices-")),
    prior = {
      HOME: process.env.HOME,
      CFIND_DATA_DIR: process.env.CFIND_DATA_DIR,
      CODEX_HOME: process.env.CODEX_HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    };
  process.env.HOME = home;
  process.env.CFIND_DATA_DIR = join(home, "metrics");
  process.env.CODEX_HOME = join(home, "codex");
  delete process.env.CLAUDE_CONFIG_DIR;
  const web = createWebServer([]);
  await new Promise<void>((resolve, reject) => {
    web.server.once("error", reject);
    web.server.listen(0, "127.0.0.1", resolve);
  });
  const port = (web.server.address() as any).port,
    base = `http://127.0.0.1:${port}`;
  return {
    ...web,
    home,
    port,
    base,
    post: (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    close() {
      web.server.closeAllConnections();
      web.server.close();
      for (const [k, v] of Object.entries(prior))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** fetch cannot set Host, so this uses http directly. */
const withHost = (port: number, host: string, path: string, auth: string) =>
  new Promise<number>((resolve, reject) => {
    request(
      { host: "127.0.0.1", port, path, headers: { host, authorization: auth } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    )
      .on("error", reject)
      .end();
  });

test("a paired device uses its own token; codes are single use and limited", async () => {
  const s = await serve();
  try {
    const start = await s.post(`/api/devices?t=${s.token}`, {
      action: "pair-start",
    });
    assert.equal(start.status, 200);
    const { code, expires } = await start.json();
    assert.match(code, /^\d{6}$/);
    assert.ok(expires > Date.now());

    const paired = await s.post("/api/pair", { code, name: "iPhone" });
    assert.equal(paired.status, 200);
    const { token, id } = await paired.json();
    assert.match(token, /^[0-9a-f]{64}$/);
    const file = readFileSync(join(s.home, "metrics", "devices.json"), "utf8");
    assert.ok(!file.includes(token), "only a hash is stored");
    assert.ok(file.includes(id));

    // K2: the same code a second time.
    assert.equal((await s.post("/api/pair", { code, name: "x" })).status, 403);

    // K4: the device token works without the per-run token.
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await fetch(s.base + "/api/workspace", { headers: auth })).status, 200);
    // K6: but not on the Mac-only routes.
    assert.equal((await s.post("/api/devices", { action: "pair-start" }, auth)).status, 403);
    assert.equal((await s.post("/api/login", { profile: "claude" }, auth)).status, 403);
    // K5: a random token.
    assert.equal(
      (await fetch(s.base + "/api/workspace", {
        headers: { authorization: "Bearer " + "0".repeat(64) },
      })).status,
      403,
    );

    // The Mac lists the device without its token.
    const list = await (await fetch(`${s.base}/api/devices?t=${s.token}`)).json();
    assert.deepEqual(list.devices.map((d: any) => [d.id, d.name]), [[id, "iPhone"]]);
    assert.equal(list.devices[0].hash, undefined);

    // K5: revoke.
    assert.equal(
      (await s.post(`/api/devices?t=${s.token}`, { action: "revoke", id })).status,
      200,
    );
    assert.equal((await fetch(s.base + "/api/workspace", { headers: auth })).status, 403);
  } finally {
    s.close();
  }
});

test("wrong codes end a pairing and too many attempts are refused", async () => {
  const s = await serve();
  try {
    const { code } = await (
      await s.post(`/api/devices?t=${s.token}`, { action: "pair-start" })
    ).json();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++)
      assert.equal((await s.post("/api/pair", { code: wrong })).status, 403);
    // K2: after 5 wrong tries the right code no longer works.
    assert.equal((await s.post("/api/pair", { code })).status, 403);
    // K3: more than 10 attempts in a minute.
    for (let i = 0; i < 4; i++) await s.post("/api/pair", { code: wrong });
    assert.equal((await s.post("/api/pair", { code: wrong })).status, 429);
  } finally {
    s.close();
  }
});

test("pairing codes expire", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-devices-")),
    devices = new Devices(join(dir, "devices.json"));
  try {
    let now = 1_000_000;
    devices.now = () => now;
    const { code } = devices.startPairing();
    now += 5 * 60 * 1000 + 1;
    assert.throws(() => devices.pair(code, "late"), /expired|not valid/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the paired tailnet host is allowed and other hosts are not", async () => {
  const s = await serve();
  try {
    const devices = new Devices(join(s.home, "metrics", "devices.json"));
    devices.setHost("mac.tail1234.ts.net");
    const { code } = devices.startPairing();
    const { token } = devices.pair(code, "iPhone");
    const auth = `Bearer ${token}`;
    assert.equal(await withHost(s.port, "mac.tail1234.ts.net", "/api/workspace", auth), 200);
    assert.equal(await withHost(s.port, "evil.example", "/api/workspace", auth), 403);
    assert.equal(await withHost(s.port, `127.0.0.1:${s.port}`, "/api/workspace", auth), 200);
  } finally {
    s.close();
  }
});

test("a repeated client id returns the first result and sends once", async () => {
  const s = await serve();
  try {
    let calls = 0;
    s.workspace.dismiss = () => {
      calls++;
    };
    const body = { action: "dismiss", id: "a", clientId: "c-1" };
    assert.equal((await s.post(`/api/agent?t=${s.token}`, body)).status, 200);
    assert.equal((await s.post(`/api/agent?t=${s.token}`, body)).status, 200);
    assert.equal(calls, 1);
  } finally {
    s.close();
  }
});
