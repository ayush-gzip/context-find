# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Behavioral guidelines

Reduce common LLM coding mistakes. Bias toward caution over speed; for trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

**Working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

### 5. Persist Test Plans

**After every testing cycle, write a detailed plan to the repo root as `feat_<feature_name>_test.md`.**

Content: what was tested, environment/build commands, env vars/flags, test cases with expected vs actual, verification steps, edge cases, what to re-run before touching this area again. Future sessions read this to skip re-deriving setup and to catch regressions the same way.

Check for an existing `feat_<feature_name>_test.md` before writing a new one — extend the existing file, don't fork.

## What this is

`context-find` is a fast search and resume tool for Claude Code and Codex conversation transcripts across all local working directories and remote machines over SSH.

- **`src/context_find/store.py`** — Canonical Python agent shipped over SSH stdin. Deliberately self-contained and stdlib-only so remote machines need nothing installed beyond Python 3.
- **`ts/src/store.ts`** — Local transcript discovery, scanning, and rendering. Maintained in strict parity with `store.py`.
- **`ts/src/remote.ts`** — SSH transport, host configuration (`~/.context-find/hosts`), argument transport, output bounds, response validation, and shell quoting.
- **`ts/src/search.ts`** — Progressive local-then-remote search with subscriber notifications.
- **`ts/src/rows.ts`** — Terminal layout, truncation, and keyboard navigation math.
- **`ts/src/ui.tsx`** — Interactive Ink/React terminal UI for browsing, reading, and resuming sessions.
- **`ts/src/web.ts`** — Localhost-only web interface with single-page reader, Host header validation, and strict token authentication.
- **`ts/src/cli.tsx`** — CLI entry point, list mode, `show` command, `web` mode, and resume dispatch.

## Build & Test

```sh
cd ts
npm run build      # tsc, then copies store.py into dist/
npm test           # runs test suite including cross-language parity
npm run typecheck  # tsc --noEmit
```

- Tests run with Node's native test runner (`node --test`).
- Golden tests compare local TypeScript scanner/renderer against `store.py` across widths and flags. Any change to parsing, rendering, or sanitization in `store.ts` must be mirrored in `store.py`.
- `npm run build` is required before tests that exercise the packaged remote agent bundle (`dist/remote.js` and `dist/store.py`).

## Security boundaries

- **Web interface:** Binds strictly to `127.0.0.1`. Every request validates the `Host` header against the exact permitted host and port before serving content (preventing DNS rebinding and token disclosure). API calls require a per-run random hex token.
- **Host resolution:** Remote requests resolve against the stored host configuration; HTTP-supplied connection options are never passed to SSH.
- **Path containment:** File paths in `/api/session` are resolved to canonical real paths and validated for containment inside configured transcript directories (`~/.claude/projects`, `~/.codex/sessions`), preventing symlink or prefix escapes.
- **Terminal sanitization:** Untrusted transcript text is sanitized to strip OSC sequences (e.g. OSC 52 clipboard injection), CSI escape sequences, and terminal control characters.
- **Shell quoting:** Resume commands use `quoteForPosixShell` to safely escape directory paths, session IDs, and command arguments.
