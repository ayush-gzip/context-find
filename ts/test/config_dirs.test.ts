import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { projectsRoots, setExtraConfigDirs } from "../src/store.ts";

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
  return spawnSync(process.execPath, ["dist/cli.js", "--list-machines", ...args],
    { encoding: "utf8", env: childEnv });
}

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

test("--extra-dir without a projects folder warns and the command still runs", () => {
  const { home } = twoStores();
  const missing = join(home, "no-such-store");
  try {
    const out = cli(home, ["--extra-dir", missing]);
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stderr.includes(`! --extra-dir ${missing}: no projects folder, skipped`), out.stderr);
    assert.ok(out.stdout.includes("this machine"), out.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
