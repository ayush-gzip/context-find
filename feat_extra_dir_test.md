# `--extra-dir` and per-store resume: test record

> 2026-10-28: the terminal list, `--json`, `--list`, `show`, `web`, `--host`, `--local` and the Ink UI were removed; `cfind` now only runs the dashboard service. Cases below about them are history. Current CLI cases: `feat_live_dashboard_test.md` E46 to E48.

## What was tested

- `--extra-dir DIR` (repeatable) adds a Claude config dir to the local search.
- Resume of a local Claude session runs `claude` with `CLAUDE_CONFIG_DIR` set to
  the store that holds the transcript. For the default `~/.claude` store,
  resume runs with `CLAUDE_CONFIG_DIR` unset.
- The `--list` resume command carries the same environment as a prefix.

## Bug that this fixes

The old `cfind` alias set `CLAUDE_CONFIG_DIR=~/.claude-personal`. The resume
child process got the same value, so `claude --resume <id>` searched only
`~/.claude-personal/projects`. A `~/.claude` session gave
`No conversation found with session ID: <id>`.

## Build and run

```sh
cd ts
npm test          # builds, then runs every test/*.test.ts
npm run build     # the global cfind is a symlink to ts/dist/cli.js
```

Environment variables: `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`. The tests set
all three to temporary dirs.

## Test cases (`ts/test/config_dirs.test.ts`)

| case | expected | actual (2026-09-21) |
| --- | --- | --- |
| `setExtraConfigDirs([X])` | roots are `X/projects`, then `~/.claude/projects` | pass |
| extra dir equal to `~/.claude` or `CLAUDE_CONFIG_DIR` | no duplicate root | pass |
| `claudeConfigDir` for a path in `X` / in `~/.claude` | `X` / `null` | pass |
| `--list --extra-dir X` | X row has `CLAUDE_CONFIG_DIR='X'`, default row has no prefix | pass |
| `--list`, no flag, no env | default row only, no `CLAUDE_CONFIG_DIR` text | pass |
| `--list` with `CLAUDE_CONFIG_DIR=X` | default row has `env -u CLAUDE_CONFIG_DIR` | pass |
| `--extra-dir` on a dir with no `projects/` | one stderr warning, exit 0 | pass |

Full suite: 61 pass, 1 fail. The failure is `Fix 5` in
`test/security_and_fixes.test.ts`, and it also fails before this change. That
test does not isolate `HOME`, so `store.py` scans the real `~/.claude`.

## Manual verification (2026-09-21)

1. Interactive resume through a pty, with a fake `claude` on `PATH` that logs
   its environment. `CLAUDE_CONFIG_DIR` was set to the personal store, as the
   old alias did.

   ```sh
   (sleep 2; printf '\r') | HOME=$S/home CODEX_HOME=$S/none \
     CLAUDE_CONFIG_DIR=$S/home/.claude-personal PATH=$S/bin:$PATH \
     script -q /dev/null node dist/cli.js --local --extra-dir $S/home/.claude-personal <query>
   ```

   Result: the `~/.claude` row ran with `CLAUDE_CONFIG_DIR=<unset>`. The
   personal row ran with `CLAUDE_CONFIG_DIR=$S/home/.claude-personal`.

2. Real Claude Code 2.1.278, shell with `CLAUDE_CONFIG_DIR=~/.claude-personal`
   exported. The printed command for a `~/.claude` session resumed it:

   ```sh
   cd '/Users/ayush/prowler-ftr' && env -u CLAUDE_CONFIG_DIR claude --resume 'fe98ceae-...' \
     -p --no-session-persistence 'reply with only the word ok'
   # ok, exit 0
   ```

## Edge cases and limits

- Do not set `CLAUDE_CONFIG_DIR=~/.claude` for default rows. Claude then reads
  `~/.claude/.claude.json` instead of `~/.claude.json`, so auth and settings
  change.
- Remote resume does not change. A session in a custom store on a remote host
  still resumes with the remote shell's own environment.
- `store.py` does not change. It is only the remote agent.
- A quoted `"~/x"` value is not expanded. The missing-folder warning shows it.

## Re-run before you change this area

- `npm test`, and look for only the known `Fix 5` failure.
- The pty check in step 1, for each store.
