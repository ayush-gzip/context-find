# Live dashboard implementation plan

**Goal:** Build the approved local agent workspace, with live analytics for Codex and both Claude profiles, session search, agent cards, and browser chat.

**Architecture:** Keep the existing Node HTTP server and CLI. Add an incremental local collector with a private disk cache, SSE updates, profile-aware Claude hooks, a Codex app-server adapter, and a Claude streaming CLI adapter. Serve a dependency-free browser application. Agent tools retain approval prompts; credentials stay in the vendor CLIs.

**Approved design:** Conversation of 2026-10-27: near-black dot grid, floating charcoal panels, Claude orange and Codex blue, live quota cards, charts, parent/subagent queue cards, browser interaction, background collection and login startup.

**Constraints:** Preserve terminal search and remote search. Local analytics only. Do not claim an open process is busy. Do not estimate unavailable quotas or billing. Do not read or expose credential files. Preserve existing Claude hooks and status-line output. Keep changes uncommitted for user review.

## Tasks

1. **Collector** (`ts/src/monitor.ts`, `ts/test/monitor.test.ts`): tests first for cumulative Codex totals, repeated Claude message records, partial appends, truncation, profile separation, restart and malformed records. Incrementally read files, track models/projects/days/relationships and freshness, and persist parser state atomically.
2. **Live service and integration** (`ts/src/collector.ts`, `ts/src/service.ts`, `ts/src/web.ts`, `ts/src/cli.tsx`): install additive Claude hooks and a status-line wrapper with backups; support daemon start/stop/status/install, launchd, authenticated SSE and metrics APIs. Test token/origin checks, reconnect snapshots and setup idempotence.
3. **Agent workspace** (`ts/src/agents.ts`, `ts/test/agents.test.ts`): use installed Codex app-server JSON-RPC and Claude stream-json processes for browser-owned sessions. Add sign-in/status, prompt queue, cancel, streamed output, permission/question replies and subagent events. Observed external sessions remain explicitly observed; do not silently duplicate a live session. Test protocol mapping, errors, queue order and cancellation without paid inference.
4. **Browser UI** (`ts/src/dashboard/*`): build the approved dark dashboard, source/date filters, usage bars/countdowns, charts, session reader, queue cards, conversation composer and account controls. Validate in a real browser at desktop/mobile widths; test live collector updates and reconnects.
5. **Session chat** (`ts/src/conversation.ts`, `ts/src/dashboard/markdown.js`, `ts/src/dashboard/dashboard.js`, `ts/src/agents.ts`): added after the user asked for an IM-style session. Structured local transcripts through `/api/conversation`, agent replies on the left and user messages on the right (swapped at the user's request on 2026-10-27), a safe dependency-free Markdown renderer, a message box in the session view, queue edits, and clickable approval and question cards. Inactive sessions continue in place; active external sessions stay read-only.
6. **Delivery** (`README.md`, `feat_live_dashboard_test.md`): build and run affected tests and regression suite; install/start the approved local service; inspect live UI and persisted setup. Record verification limits and deviations.

## Review focus

- No double counting cumulative or repeated events; cached/reasoning tokens are subsets where appropriate.
- A crash, partial write or file rotation cannot corrupt collection state or silently lose records.
- External sessions and subagents are distinguished from browser-owned controllable sessions.
- Missing telemetry, stale quota windows and disconnected streams remain visible.
- Local mutation endpoints reject cross-origin requests; agent arguments never pass through shell interpolation.

## Baseline

2026-10-27: 61/62 existing tests pass with loopback networking allowed. Existing failure: Python malformed-record scan expects one session but sees three; investigate inherited store environment in fixture. Two additional sandbox-only failures are EPERM binding loopback sockets. No product changes made before this baseline.

## Status, 2026-10-27

- Tasks 1 to 6 are implemented. Changes are not committed.
- Design deviation: the user rejected the approved dark design as too generic and asked for an Apple-style dashboard. The UI now uses light surfaces with a dark option.
- Protocol fix found during task 5: Claude print mode denies every tool that needs approval unless `--permission-prompt-tool stdio` is set. The browser adapter now sets it.
- Full suite: 77/77 pass. Real end-to-end runs passed for Claude approval, question, decline with instructions, session continuation, and a Codex command approval.
- Limits and rerun steps: `feat_live_dashboard_test.md`.
