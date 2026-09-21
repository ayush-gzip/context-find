import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { claudeConfigDir, projectsRoots, setExtraConfigDirs } from "../src/store.ts";
import { quoteForPosixShell } from "../src/remote.ts";

/** A HOME holding the default ~/.claude store and a second store beside it. */
function twoStores(): { home: string; personal: string } {
  const home = mkdtempSync(join(tmpdir(), "cfind-stores-"));
  const personal = join(home, ".claude-personal");
  const write = (config: string, slug: string, cwd: string, sid: string, text: string) => {
    const dir = join(config, "projects", slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, sid + ".jsonl"),
      JSON.stringify({ type: "user", cwd, gitBranch: "main", message: { content: text } }) + "\n");
  };
  write(join(home, ".claude"), "-w-work", "/w/work", "work-sid", "work session");
  write(personal, "-w-home", "/w/home", "home-sid", "personal session");
  return { home, personal };
}

function withEnv(env: Record<string, string | undefined>, body: () => void): void {
  const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    body();
  } finally {
    setExtraConfigDirs([]);
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function cli(home: string, args: string[], env: Record<string, string> = {}) {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, "no-codex"), ...env,
  };
  if (!("CLAUDE_CONFIG_DIR" in env)) delete childEnv["CLAUDE_CONFIG_DIR"];
  return spawnSync(process.execPath, ["dist/cli.js", "--local", "--list", ...args],
    { encoding: "utf8", env: childEnv });
}

const resumeLine = (cwd: string, prefix: string, sid: string) =>
  `cd ${quoteForPosixShell(cwd)} && ${prefix}claude --resume ${quoteForPosixShell(sid)}`;

test("extra config dirs are searched between CLAUDE_CONFIG_DIR and ~/.claude", () => {
  const { home, personal } = twoStores();
  try {
    withEnv({ HOME: home, CLAUDE_CONFIG_DIR: undefined }, () => {
      assert.deepEqual(projectsRoots(), [join(home, ".claude", "projects")]);
      setExtraConfigDirs([personal]);
      assert.deepEqual(projectsRoots(),
        [join(personal, "projects"), join(home, ".claude", "projects")]);
    });
    withEnv({ HOME: home, CLAUDE_CONFIG_DIR: personal }, () => {
      setExtraConfigDirs([personal, join(home, ".claude")]);
      assert.deepEqual(projectsRoots(),
        [join(personal, "projects"), join(home, ".claude", "projects")]);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("claudeConfigDir names the store holding a transcript, null for ~/.claude", () => {
  const { home, personal } = twoStores();
  try {
    withEnv({ HOME: home, CLAUDE_CONFIG_DIR: undefined }, () => {
      setExtraConfigDirs([personal]);
      assert.equal(claudeConfigDir(join(personal, "projects", "-w-home", "home-sid.jsonl")), personal);
      assert.equal(claudeConfigDir(join(home, ".claude", "projects", "-w-work", "work-sid.jsonl")), null);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("--extra-dir lists both stores and each resume command targets its own store", () => {
  const { home, personal } = twoStores();
  try {
    const out = cli(home, ["--extra-dir", personal]);
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.includes(
      resumeLine("/w/home", `CLAUDE_CONFIG_DIR=${quoteForPosixShell(personal)} `, "home-sid")), out.stdout);
    assert.ok(out.stdout.includes(resumeLine("/w/work", "", "work-sid")), out.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("without --extra-dir or CLAUDE_CONFIG_DIR only ~/.claude is listed, unchanged", () => {
  const { home } = twoStores();
  try {
    const out = cli(home, []);
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.includes(resumeLine("/w/work", "", "work-sid")), out.stdout);
    assert.ok(!out.stdout.includes("/w/home"));
    assert.ok(!out.stdout.includes("CLAUDE_CONFIG_DIR"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("with CLAUDE_CONFIG_DIR set, ~/.claude rows unset it so claude finds them", () => {
  const { home, personal } = twoStores();
  try {
    const out = cli(home, [], { CLAUDE_CONFIG_DIR: personal });
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.includes(resumeLine("/w/work", "env -u CLAUDE_CONFIG_DIR ", "work-sid")), out.stdout);
    assert.ok(out.stdout.includes(
      resumeLine("/w/home", `CLAUDE_CONFIG_DIR=${quoteForPosixShell(personal)} `, "home-sid")), out.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("--extra-dir without a projects folder warns and still lists the rest", () => {
  const { home } = twoStores();
  const missing = join(home, "no-such-store");
  try {
    const out = cli(home, ["--extra-dir", missing]);
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stderr.includes(`! --extra-dir ${missing}: no projects folder, skipped`), out.stderr);
    assert.ok(out.stdout.includes(resumeLine("/w/work", "", "work-sid")), out.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
