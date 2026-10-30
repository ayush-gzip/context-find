import assert from "node:assert/strict";
import test from "node:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebServer } from "../src/web.ts";

test("dashboard APIs authenticate, reject foreign origins, and stream a fresh snapshot on reconnect", async () => {
  const home = mkdtempSync(join(tmpdir(), "cfind-api-")),
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
  const root = join(home, ".claude", "projects", "project");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "s.jsonl"),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-10-27T12:00:00Z",
      sessionId: "s",
      message: {
        id: "m",
        model: "opus",
        usage: { input_tokens: 3, output_tokens: 7 },
      },
    }) + "\n",
  );
  const { server, token } = createWebServer([]);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as any).port,
      base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(base + "/api/metrics")).status, 403);
    assert.equal(
      (
        await fetch(base + "/api/agent?t=" + token, {
          method: "POST",
          headers: {
            origin: "https://example.com",
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal((await fetch(base + "/api/agent?t=" + token)).status, 405);
    const metrics = await (
      await fetch(base + "/api/metrics?t=" + token)
    ).json();
    assert.equal(metrics.profiles[0].tokens.output, 7);
    for (let i = 0; i < 2; i++) {
      const controller = new AbortController(),
        r = await fetch(base + "/api/events?t=" + token, {
          signal: controller.signal,
        });
      assert.equal(r.headers.get("content-type"), "text/event-stream");
      const reader = r.body!.getReader(),
        chunk = await reader.read();
      assert.match(new TextDecoder().decode(chunk.value), /event: metrics/);
      controller.abort();
    }
    writeFileSync(
      join(root, "chat.jsonl"),
      JSON.stringify({
        type: "user",
        uuid: "u",
        message: { content: "<b>hi</b>" },
      }) + "\n",
    );
    writeFileSync(join(home, "outside.jsonl"), "{}\n");
    symlinkSync(join(home, "outside.jsonl"), join(root, "escape.jsonl"));
    const conversation = (path: string, t = token) =>
      fetch(
        base + "/api/conversation?path=" + encodeURIComponent(path) + "&t=" + t,
      );
    const chat = await conversation(join(root, "chat.jsonl"));
    assert.equal(chat.status, 200);
    assert.deepEqual(
      (await chat.json()).messages.map((m: any) => m.text),
      ["<b>hi</b>"],
    );
    assert.equal(
      (await conversation(join(root, "chat.jsonl"), "wrong")).status,
      403,
    );
    assert.equal((await conversation(join(home, "outside.jsonl"))).status, 403);
    assert.equal((await conversation(join(root, "escape.jsonl"))).status, 403);
    assert.equal((await conversation(join(root, "missing.jsonl"))).status, 404);
    // An open chat streams its messages, then each new one, over its own stream.
    const chatEvents = (path: string, t = token) =>
      fetch(
        base + "/api/chat-events?path=" + encodeURIComponent(path) + "&t=" + t,
      );
    assert.equal(
      (await chatEvents(join(root, "chat.jsonl"), "wrong")).status,
      403,
    );
    assert.equal((await chatEvents(join(home, "outside.jsonl"))).status, 403);
    assert.equal((await chatEvents(join(root, "escape.jsonl"))).status, 403);
    const live = await chatEvents(join(root, "chat.jsonl"));
    assert.equal(live.headers.get("content-type"), "text/event-stream");
    const frames = live.body!.getReader(),
      next = async () => new TextDecoder().decode((await frames.read()).value);
    assert.match(await next(), /event: chat\ndata: .*<b>hi<\/b>/);
    appendFileSync(
      join(root, "chat.jsonl"),
      JSON.stringify({
        type: "user",
        uuid: "u2",
        message: { content: "more" },
      }) + "\n",
    );
    assert.match(await next(), /event: chat-delta\ndata: .*"more"/);
    await frames.cancel();
    const deltas = (
      await fetch(base + "/api/events?delta=1&t=" + token)
    ).body!.getReader();
    let first = "";
    while (!/event: workspace/.test(first))
      first += new TextDecoder().decode((await deltas.read()).value);
    assert.match(first, /^event: metrics\n/);
    await deltas.cancel();
    const script = await fetch(base + "/markdown.js");
    assert.equal(script.headers.get("content-type"), "text/javascript");
    const bad = await fetch(base + "/api/agent?t=" + token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "create",
        profile: "invented",
        cwd: home,
        prompt: "task",
      }),
    });
    assert.notEqual(bad.status, 200);
    assert.match((await bad.json()).error, /profile/i);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("image uploads accept real images only and serve them back safely", async () => {
  const home = mkdtempSync(join(tmpdir(), "cfind-upload-")),
    prior = {
      HOME: process.env.HOME,
      CFIND_DATA_DIR: process.env.CFIND_DATA_DIR,
    };
  process.env.HOME = home;
  process.env.CFIND_DATA_DIR = join(home, "metrics");
  const { server, token } = createWebServer([]);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${(server.address() as any).port}`,
      up = (body: Buffer | string, type = "image/png") =>
        fetch(`${base}/api/upload?t=${token}`, {
          method: "POST",
          headers: { "content-type": type },
          body,
        });
    const png = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      Buffer.alloc(32, 1),
    ]);
    const saved = await up(png);
    assert.equal(saved.status, 200);
    const { id } = await saved.json();
    assert.match(id, /^[0-9a-f]{32}\.png$/);
    assert.equal(
      (await up(Buffer.from("GIF89a....."), "image/gif")).status,
      200,
    );
    assert.equal((await up("<svg onload=alert(1)>", "image/png")).status, 415);
    assert.equal((await up(png, "text/plain")).status, 415);
    assert.equal(
      (await up(Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]))).status,
      413,
    );
    assert.equal((await fetch(`${base}/api/upload?id=${id}`)).status, 403);
    const got = await fetch(`${base}/api/upload?t=${token}&id=${id}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "image/png");
    assert.equal(got.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);
    for (const [bad, status] of [
      ["../metrics.json", 400],
      ["..%2Fworkspace.json", 400],
      ["0".repeat(32) + ".png", 404],
    ] as const)
      assert.equal(
        (await fetch(`${base}/api/upload?t=${token}&id=${bad}`)).status,
        status,
      );
    // Images go after 7 days, and Settings can clear them all.
    const dir = join(home, "metrics", "uploads"),
      old = "a".repeat(32) + ".png";
    writeFileSync(join(dir, old), png);
    const week = (Date.now() - 8 * 86400000) / 1000;
    utimesSync(join(dir, old), week, week);
    assert.equal((await up(png)).status, 200);
    assert.ok(!existsSync(join(dir, old)), "an old image is removed");
    const stats = await (await fetch(`${base}/api/uploads?t=${token}`)).json();
    assert.deepEqual([stats.count, stats.keepDays], [3, 7]);
    assert.ok(stats.bytes > 0);
    const clear = (body: unknown) =>
      fetch(`${base}/api/uploads?t=${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal((await clear({ action: "other" })).status, 400);
    assert.deepEqual(await (await clear({ action: "clear" })).json(), {
      removed: 3,
    });
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    server.close();
    for (const [k, v] of Object.entries(prior))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    rmSync(home, { recursive: true, force: true });
  }
});
