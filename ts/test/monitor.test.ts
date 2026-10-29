import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Monitor } from "../src/monitor.ts";
import { stripPasteTags } from "../src/conversation.ts";

const stamp = "2026-10-27T10:00:00Z";
const claude = (id: string, output: number) => ({
  type: "assistant",
  timestamp: stamp,
  sessionId: "s1",
  cwd: "/project",
  message: {
    id,
    model: "opus",
    usage: {
      input_tokens: 10,
      output_tokens: output,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
    },
  },
});
const codex = (input: number, output: number) => ({
  type: "event_msg",
  timestamp: stamp,
  payload: {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: input,
        output_tokens: output,
        cached_input_tokens: 20,
        reasoning_output_tokens: 2,
      },
    },
  },
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "cfind-monitor-"));
  const roots = [
    {
      id: "claude",
      label: "Claude",
      source: "claude" as const,
      path: join(home, "claude"),
    },
    {
      id: "personal",
      label: "Personal",
      source: "claude" as const,
      path: join(home, "personal"),
    },
    {
      id: "codex",
      label: "Codex",
      source: "codex" as const,
      path: join(home, "codex"),
    },
  ];
  roots.forEach((r) => mkdirSync(r.path));
  return { home, roots, options: { roots, dataDir: join(home, "data") } };
}
test("synthetic Claude errors keep the real model and add no usage buckets", async () => {
  const f = fixture();
  try {
    const synthetic = {
      ...claude("error", 0),
      message: {
        id: "error",
        model: "<synthetic>",
        content: [{ type: "text", text: "You're out of usage credits" }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
    writeFileSync(join(f.roots[0]!.path, "real.jsonl"),
      [claude("real", 3), synthetic].map((r) => JSON.stringify(r)).join("\n") + "\n");
    writeFileSync(join(f.roots[1]!.path, "error.jsonl"), JSON.stringify(synthetic) + "\n");
    const monitor = new Monitor(f.options);
    await monitor.refresh();
    const d = monitor.snapshot();
    assert.equal(d.sessions.find((s) => s.profile === "claude")!.model, "opus");
    assert.equal(d.sessions.find((s) => s.profile === "personal")!.model, "Unknown");
    assert.ok(d.usage.every((u) => u.model !== "<synthetic>"));
    assert.equal(d.profiles.find((p) => p.id === "claude")!.tokens.output, 3);
    assert.equal(d.sessions.find((s) => s.profile === "personal")!.usageAvailable, false);
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});
test("version 2 metrics are rebuilt from transcripts to correct synthetic model labels", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.roots[0]!.path, "real.jsonl"), JSON.stringify(claude("real", 3)) + "\n");
    const monitor = new Monitor(f.options);
    await monitor.refresh();
    const path = join(f.options.dataDir, "metrics.json");
    const old = JSON.parse(readFileSync(path, "utf8"));
    old.version = 2;
    Object.values(old.files).forEach((f: any) => { f.session.model = "<synthetic>"; });
    writeFileSync(path, JSON.stringify(old));
    const restarted = new Monitor(f.options);
    await restarted.refresh();
    assert.equal(restarted.snapshot().sessions[0]!.model, "opus");
    assert.equal(restarted.snapshot().profiles[0]!.tokens.output, 3);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 4);
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});
test("usage separates profiles and counts repeated Claude message blocks once", async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.roots[0]!.path, "s1.jsonl"),
      [claude("m1", 2), claude("m1", 5), claude("m2", 3), null, 5]
        .map((x) => JSON.stringify(x))
        .join("\n") + "\n",
    );
    writeFileSync(
      join(f.roots[1]!.path, "s1.jsonl"),
      JSON.stringify(claude("m1", 7)) + "\n",
    );
    const monitor = new Monitor(f.options);
    await monitor.refresh();
    const d = monitor.snapshot();
    assert.equal(d.profiles.find((p) => p.id === "claude")!.tokens.output, 8);
    assert.equal(d.profiles.find((p) => p.id === "claude")!.tokens.input, 20);
    assert.equal(d.profiles.find((p) => p.id === "personal")!.tokens.output, 7);
    assert.equal(d.sessions.length, 2);
    assert.equal(
      d.days.reduce((sum, b) => sum + b.tokens.output, 0),
      15,
    );
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});
test("Codex cumulative counts are deltas; partial appends and restart do not duplicate usage", async () => {
  const f = fixture();
  try {
    const path = join(f.roots[2]!.path, "rollout-a.jsonl");
    writeFileSync(
      path,
      [
        { type: "session_meta", payload: { id: "cx", cwd: "/project" } },
        codex(100, 10),
        codex(100, 10),
      ]
        .map((x) => JSON.stringify(x))
        .join("\n") + "\n",
    );
    const monitor = new Monitor(f.options);
    await monitor.refresh();
    assert.equal(
      monitor.snapshot().profiles.find((p) => p.id === "codex")!.tokens.input,
      100,
    );
    const next = JSON.stringify(codex(150, 15));
    appendFileSync(path, next.slice(0, 25));
    await monitor.refresh();
    appendFileSync(path, next.slice(25) + "\n");
    await monitor.refresh();
    assert.equal(
      monitor.snapshot().profiles.find((p) => p.id === "codex")!.tokens.output,
      15,
    );
    const restarted = new Monitor(f.options);
    await restarted.refresh();
    assert.equal(
      restarted.snapshot().profiles.find((p) => p.id === "codex")!.tokens.input,
      150,
    );
    writeFileSync(path, JSON.stringify(codex(40, 4)) + "\n");
    await restarted.refresh();
    assert.equal(
      restarted.snapshot().profiles.find((p) => p.id === "codex")!.tokens.input,
      40,
    );
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});
test("a Claude session with a live process is open even when idle", async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.roots[0]!.path, "s1.jsonl"),
      JSON.stringify(claude("m1", 2)) + "\n",
    );
    writeFileSync(
      join(f.roots[0]!.path, "s2.jsonl"),
      JSON.stringify({ ...claude("m2", 2), sessionId: "s2" }) + "\n",
    );
    mkdirSync(join(f.home, "sessions"));
    writeFileSync(
      join(f.home, "sessions", "1.json"),
      JSON.stringify({
        pid: process.pid,
        sessionId: "s1",
        status: "idle",
        tmux: "Work:@0.%9",
      }),
    );
    writeFileSync(
      join(f.roots[1]!.path, "s3.jsonl"),
      JSON.stringify({ ...claude("m3", 2), sessionId: "s3" }) + "\n",
    );
    mkdirSync(join(f.home, "data", "live"), { recursive: true });
    writeFileSync(
      join(f.home, "data", "live", "3.json"),
      JSON.stringify({
        profile: "personal",
        pid: process.pid,
        sessionId: "s3",
        status: "busy",
      }),
    );
    writeFileSync(
      join(f.home, "sessions", "2.json"),
      JSON.stringify({ pid: 2 ** 22 + 1, sessionId: "s2", status: "idle" }),
    );
    // Turn over, background shell tasks still running.
    writeFileSync(
      join(f.roots[0]!.path, "s4.jsonl"),
      JSON.stringify({ ...claude("m4", 2), sessionId: "s4" }) + "\n",
    );
    writeFileSync(
      join(f.home, "sessions", "4.json"),
      JSON.stringify({ pid: process.pid, sessionId: "s4", status: "shell" }),
    );
    const monitor = new Monitor(f.options);
    await monitor.refresh();
    const s = (id: string) =>
      monitor
        .snapshot()
        .sessions.find((s) => s.profile === "claude" && s.id === id)!;
    assert.equal(s("s1").state, "idle");
    assert.equal(s("s1").open, true);
    assert.equal(s("s1").tmux, true);
    assert.equal(s("s2").open, undefined);
    assert.equal(s("s4").state, "running");
    assert.equal(monitor.live("claude", "s1")!.tmux, "%9");
    const codexStyle = monitor
      .snapshot()
      .sessions.find((s) => s.profile === "personal" && s.id === "s3")!;
    assert.equal(codexStyle.state, "running");
    assert.equal(codexStyle.open, true);
    assert.equal(codexStyle.tmux, undefined);
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});
test("status line limits and cost go to the profile that holds the transcript", async () => {
  const f = fixture();
  try {
    // A personal session started in the home folder also loads ~/.claude/settings.json
    // as project settings, so its status line arrives tagged with the default profile.
    writeFileSync(
      join(f.roots[1]!.path, "p1.jsonl"),
      JSON.stringify({ ...claude("m1", 2), sessionId: "p1" }) + "\n",
    );
    mkdirSync(join(f.home, "data", "signals"), { recursive: true });
    const signal = (name: string, sessionId: string, used: number) =>
      writeFileSync(
        join(f.home, "data", "signals", name + ".json"),
        JSON.stringify({
          kind: "statusline",
          profile: "claude",
          sessionId,
          updatedAt: Date.now(),
          rate_limits: {
            five_hour: { used_percentage: used, resets_at: 2000000000 },
          },
          cost: { total_cost_usd: 1.5 },
        }),
      );
    signal("a", "p1", 40);
    signal("b", "unknown-session", 10);
    const monitor = new Monitor(f.options);
    await monitor.refresh();
    const d = monitor.snapshot();
    const limits = (id: string) =>
      d.profiles.find((p) => p.id === id)!.limits?.session?.used;
    assert.equal(limits("personal"), 40);
    assert.equal(limits("claude"), 10);
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});
test("a Claude message copied into another file counts once per profile", async () => {
  const f = fixture();
  try {
    const row = (
      id: string,
      sessionId: string,
      timestamp: string,
      output: number,
    ) => JSON.stringify({ ...claude(id, output), sessionId, timestamp }) + "\n";
    // The original session, then a resumed copy that repeats m1 and adds m2.
    writeFileSync(
      join(f.roots[0]!.path, "a.jsonl"),
      row("m1", "a", "2026-10-26T10:00:00Z", 100),
    );
    writeFileSync(
      join(f.roots[0]!.path, "b.jsonl"),
      row("m1", "b", "2026-10-27T09:00:00Z", 100) +
        row("m2", "b", "2026-10-27T09:01:00Z", 7),
    );
    // Another account with the same id is a different request.
    writeFileSync(
      join(f.roots[1]!.path, "c.jsonl"),
      row("m1", "c", "2026-10-27T09:00:00Z", 100),
    );
    const monitor = new Monitor(f.options);
    await monitor.refresh();
    let d = monitor.snapshot();
    const out = (id: string) =>
      d.profiles.find((p) => p.id === id)!.tokens.output;
    const session = (id: string) =>
      d.sessions.find((s) => s.id === id)!.tokens.output;
    const days = (profile: string) =>
      d.days
        .filter((b) => b.profile === profile)
        .reduce((sum, b) => sum + b.tokens.output, 0);
    assert.equal(out("claude"), 107);
    assert.equal(days("claude"), 107);
    assert.equal(session("a"), 100);
    assert.equal(session("b"), 7);
    assert.equal(out("personal"), 100);
    // Deleting the owner hands the message to the copy.
    rmSync(join(f.roots[0]!.path, "a.jsonl"));
    await monitor.refresh();
    d = monitor.snapshot();
    assert.equal(out("claude"), 107);
    assert.equal(session("b"), 107);
    // A cache written before the slot map existed is ignored.
    writeFileSync(
      join(f.home, "data", "metrics.json"),
      JSON.stringify({ version: 1, files: { x: {} } }),
    );
    const fresh = new Monitor(f.options);
    await fresh.refresh();
    d = fresh.snapshot();
    assert.equal(out("claude"), 107);
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});
test("session titles drop Claude's paste tags", async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.roots[0]!.path, "s1.jsonl"),
      JSON.stringify({
        type: "user",
        timestamp: stamp,
        sessionId: "s1",
        cwd: "/project",
        message: {
          content:
            'refer to <pasted_content id="a1cc">\nAcme profiles\n</pasted_content id="a1cc">',
        },
      }) + "\n",
    );
    const monitor = new Monitor(f.options);
    await monitor.refresh();
    assert.equal(
      monitor.snapshot().sessions[0]!.title,
      "refer to \nAcme profiles\n",
    );
    assert.equal(stripPasteTags('look \n<pasted_content id="5cdd'), "look \n");
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});
test("after start, watched folders are read without a full walk; clients hear only changes", async () => {
  const f = fixture();
  const monitor = new Monitor(f.options);
  let heard = 0;
  monitor.subscribe(() => heard++);
  const until = async (ok: () => boolean) => {
    for (const end = Date.now() + 4000; !ok(); ) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 50));
      await monitor.refresh();
    }
  };
  const output = () =>
    monitor.snapshot().profiles.find((p) => p.id === "personal")!.tokens.output;
  try {
    monitor.start();
    await monitor.refresh();
    // macOS starts delivering folder events a moment after the watch begins.
    await new Promise((r) => setTimeout(r, 500));
    // Within the first minute only the watchers can report these.
    const dir = join(f.roots[1]!.path, "new-project"),
      path = join(dir, "s2.jsonl");
    mkdirSync(dir);
    writeFileSync(path, JSON.stringify(claude("m1", 7)) + "\n");
    await until(() => monitor.snapshot().sessions.length === 1);
    appendFileSync(path, JSON.stringify(claude("m2", 3)) + "\n");
    await until(() => output() === 10);
    const before = heard;
    await monitor.refresh();
    await monitor.refresh();
    assert.equal(heard, before, "no change, no update");
    // stop() saves what the minute's limit held back.
    monitor.stop();
    assert.equal(
      new Monitor(f.options).snapshot().profiles.find((p) => p.id === "personal")!
        .tokens.output,
      10,
    );
    monitor.start();
    await new Promise((r) => setTimeout(r, 500));
    rmSync(path);
    await until(() => monitor.snapshot().sessions.length === 0);
  } finally {
    monitor.stop();
    rmSync(f.home, { recursive: true, force: true });
  }
});
