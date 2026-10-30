import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { claudeCommands, frontmatter } from "../src/commands.ts";

test("the / menu lists Claude's init commands with descriptions from their files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-commands-")),
    config = join(dir, "config"),
    project = join(dir, "project"),
    plugin = join(dir, "plugin"),
    binary = join(dir, "claude"),
    calls = join(dir, "calls"),
    prior = process.env.CFIND_CLAUDE_BIN;
  mkdirSync(join(config, "skills", "my-skill"), { recursive: true });
  writeFileSync(
    join(config, "skills", "my-skill", "SKILL.md"),
    "---\nname: my-skill\ndescription: >\n  Does one thing\n  well.\nargument-hint: <file>\n---\nBody\n",
  );
  mkdirSync(join(project, ".claude", "commands"), { recursive: true });
  writeFileSync(
    join(project, ".claude", "commands", "ship.md"),
    '---\ndescription: "Ship it"\n---\n',
  );
  mkdirSync(join(plugin, "commands"), { recursive: true });
  writeFileSync(
    join(plugin, "commands", "do.md"),
    "---\ndescription: Plugin command\n---\n",
  );
  // Prints the init event, then hangs as if waiting on the model.
  writeFileSync(
    binary,
    `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');
console.log(JSON.stringify({type:'system',subtype:'init',
  slash_commands:['compact','my-skill','ship','plug:do','__internal','doctor','mystery'],
  terminal_slash_commands:['doctor'],
  plugins:[{name:'plug',path:${JSON.stringify(plugin)}}]}));
setInterval(() => {}, 1000);
`,
    { mode: 0o700 },
  );
  process.env.CFIND_CLAUDE_BIN = binary;
  try {
    const list = await claudeCommands(process.env, config, project);
    assert.deepEqual(list, [
      {
        name: "compact",
        description: "Summarize the conversation to free up context",
      },
      {
        name: "my-skill",
        description: "Does one thing well.",
        hint: "<file>",
      },
      { name: "ship", description: "Ship it" },
      { name: "plug:do", description: "Plugin command" },
      {
        name: "doctor",
        description: "Check the Claude Code install",
        terminal: true,
      },
      { name: "mystery" },
    ]);
    // Claude is asked once per folder; it runs a local command with hooks off.
    assert.equal(await claudeCommands(process.env, config, project), list);
    const args = readFileSync(calls, "utf8").trim().split("\n");
    assert.equal(args.length, 1);
    assert.match(args[0]!, /^-p \/cost .*--strict-mcp-config/);
    assert.match(args[0]!, /disableAllHooks/);
  } finally {
    if (prior === undefined) delete process.env.CFIND_CLAUDE_BIN;
    else process.env.CFIND_CLAUDE_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed command list is not cached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-commands-")),
    binary = join(dir, "claude"),
    prior = process.env.CFIND_CLAUDE_BIN;
  writeFileSync(binary, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  process.env.CFIND_CLAUDE_BIN = binary;
  try {
    await assert.rejects(claudeCommands(process.env, dir, dir), /did not list/);
    writeFileSync(
      binary,
      `#!/bin/sh\necho '{"type":"system","subtype":"init","slash_commands":["init"]}'\n`,
    );
    assert.deepEqual(await claudeCommands(process.env, dir, dir), [
      { name: "init", description: "Write a CLAUDE.md for this project" },
    ]);
  } finally {
    if (prior === undefined) delete process.env.CFIND_CLAUDE_BIN;
    else process.env.CFIND_CLAUDE_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("frontmatter reads quoted, folded and missing headers", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfind-front-"));
  try {
    const file = join(dir, "a.md");
    writeFileSync(
      file,
      "---\nname: 'x'\ndescription: |\n  one\n\n  two\nother: y\n---\n",
    );
    assert.deepEqual(frontmatter(file), {
      name: "x",
      description: "one  two",
      other: "y",
    });
    writeFileSync(file, "no header\n");
    assert.deepEqual(frontmatter(file), {});
    assert.deepEqual(frontmatter(join(dir, "missing.md")), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
