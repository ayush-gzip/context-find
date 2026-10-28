# Codex Interaction Implementation Plan

Goal: Order agent cards by last conversation activity, then support Codex interaction
from cfind: slash commands, model and reasoning selection, messages, stop, questions,
and approvals, including sessions already running in the local shared daemon.

Architecture: Connect to the existing local Codex daemon over its Unix WebSocket.
Join a running thread with thread/resume and no configuration overrides. Use the
same thread and request IDs for all control actions. Keep transcript watches for
attached chats so opening one never duplicates streamed messages.

Tech stack: existing TypeScript/Node dashboard; ws for Node 18 Unix WebSocket support.
Spec: user requests in this session; execution authorized by "Once done, move ahead
with the interaction controls and all". Gradient work remains outside this plan.

Evidence: current CLI-generated protocol; official OpenAI app-server documentation
at https://learn.chatgpt.com/docs/app-server; two real clients joined the same isolated
thread, both received its command approval, the attached client declined it, and
serverRequest/resolved was received. Existing user threads were not changed.

Constraints: preserve Claude behavior and existing edits; keep token/origin/path
validation; no daemon restarts, remote exposure, permission changes during attach,
guessed terminal mapping, automatic approval, or duplicate private writer. The
permission and model pickers apply only explicit user choices to the selected thread.

## Tasks

- [x] Sort merged owned/external cards and child cards by updatedAt, newest first,
  with deterministic ties. Update queued-input, approval-answer and stop timestamps.
  Verify browser order in Agents and Overview, deduplication, scroll retention,
  and the existing agent regression tests.
- [ ] Add shared WebSocket transport in ts/src/codex.ts; retain fake-binary stdio
  support for current protocol tests. Verify request correlation, errors, disconnect,
  close without stopping the shared daemon, and no fallback private writer.
- [ ] Add idempotent thread attachment and live state to agents.ts and web.ts.
  Track pending requests by ID, clear requests resolved elsewhere, and reject stale
  answers. Resume without changing the session's model, approval policy or sandbox.
- [ ] Add Codex commands through model/list, skills/list and thread control APIs.
  Handle commands as actions, reject unsupported commands clearly, and send skills
  as explicit skill input rather than ordinary slash-prefixed prompt text.
- [ ] Extend dashboard.js slash menu and chat attachment. Render schema-based MCP
  questions/confirmation choices and forward typed values. Preserve approval scope
  and expose only supported decisions; never turn a once-only grant into persistence.
- [ ] Validate fake-protocol regression tests, browser interactions, TypeScript
  build/typecheck, full regression suite, and an isolated real Codex approval roundtrip.
  Record results in feat_live_dashboard_test.md. Load the update only when the
  dashboard has no active work that a service restart would interrupt.

Main failure cases: disconnect/reconnect; approval answered from the terminal;
several pending questions on one thread; unavailable shared daemon; invalid command
arguments; unsupported form schemas. Show errors without silently sending commands
as ordinary messages or accepting a different pending request.
