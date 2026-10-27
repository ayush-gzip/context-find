# Codex live TUI owner record: investigation and test results

Date: 2026-10-27 (Asia/Kolkata).
Repository: `/Users/ayush/Documents/Personal/context-find`.

## Result: stopped at the required ownership check

The requested collector was **not installed or implemented**. The user required
work to stop if a thread could not be mapped reliably to its TUI PID. A real test
confirmed that the shared-daemon hook's parent PID and TMUX_PANE identify the
server's environment, not the attached TUI. The hook input did not contain a
client/TUI PID or pane field. No guessed `<dataDir>/live/<pid>.json` was written.

`ts/src/collector.ts` and `ts/test/collector.test.ts` were not edited by this task.
The only repository changes made by this task are this test report and one short
README paragraph. Claude's concurrent uncommitted work was preserved. No commit
or push was made.

## Documentation and native record check

Checked the official hook input contract, lifecycle events, discovery locations,
trust flow, async behavior, CLI help and daemon help. Inspected runtime directory
file names (not auth files) under `.codex/ipc`, `.codex/app-server-control`, and
`.codex/app-server-daemon`. No documented file with the required live
thread/TUI PID/pane/menu-state mapping was found.

Official references:
- https://learn.chatgpt.com/docs/hooks#common-input-fields
- https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks
- https://learn.chatgpt.com/docs/developer-commands#codex-queue

The official hook input lists session_id, transcript_path, cwd,
hook_event_name, model and event-specific fields. It does not document the TUI
PID or tmux pane. The real probe confirmed the same field set for the events
observed below. This is a finding for the versions tested, not proof that no
future native integration can expose ownership.

Read-only commands:
```sh
codex --version
codex features list
codex app-server daemon version
codex --help
codex app-server daemon --help
codex queue --help
```

Observed:
- CLI: `0.163.0`.
- `hooks`: stable, enabled.
- `daemon_auto_start`: stable, enabled.
- Running app-server: `0.164.0`.
- The shared daemon was already running before this task and was not restarted,
  stopped, killed, or controlled by the probe.

## Diagnostic hook

Temporary evidence directory:
`/private/tmp/cfind-codex-hook-probe-dck40szf`.

Files:
- `probe.py`: authored diagnostic hook.
- `events.jsonl`: observed hook metadata and parent process chain.
- `test.json`, `shared-test.json`, `default-test.json`: test pane/PID metadata.
- `start.sh`, `start-shared.sh`, `start-default.sh`: exact launch commands.
- `shared/.codex/hooks.json`: diagnostic project hook definitions.

The probe read JSON from stdin and wrote only hook event, session ID, cwd,
input field NAMES, selected environment field NAMES, TMUX_PANE, process IDs,
parent process names/TTYs, and observation time. It did not log prompt text,
tool input, full environment values, credentials, or authentication files.
It exited successfully without stdout on errors. Each command had a two-second
timeout and did not make a policy or approval decision.

Hook events configured: SessionStart, UserPromptSubmit, PreToolUse,
PermissionRequest, PostToolUse, Stop, Interrupt, SessionEnd.

## Real tmux runs

Only new test sessions created by this task were sent keys. Existing panes were
not selected, attached, sent input, stopped, or killed.

### A. Command-line hook overrides: misleading success

Started a new tmux session with `codex -c 'hooks.<event>=...'`, plus the reviewed
hook-trust bypass flag. Test TUI: PID `34399`, pane `%15`.
Sent a single tool-free prompt asking for `CFIND_HOOK_OK`; that reply arrived.

Observed SessionStart, UserPromptSubmit, and Stop:
- Hook parent: TUI PID `34399`.
- Hook TMUX_PANE: `%15`.
- Thread: `01a17d43-0a13-7862-8c23-7dd94ca01ac5`.

The TUI warning explained why this was not sufficient:
`Running without the shared background server: command-line configuration overrides (-c, --enable, --disable, or --search) requires embedded mode.`

This run proved embedded hooks can see their parent TUI. It did not prove the
requested integration works with the shared server.

### B. Project hooks plus trust bypass: still embedded

Started a second test TUI with project hooks and no `-c` options, but retained
`--dangerously-bypass-hook-trust`. Test TUI: PID `40631`, pane `%16`.
No model prompt was submitted in this run.

The TUI warning stated:
`Running without the shared background server: --dangerously-bypass-hook-trust requires embedded mode.`

Therefore neither per-invocation hook overrides nor the hook-trust bypass flag
is a valid way to test the normal shared-daemon ownership problem.

### C. Normal shared-daemon mode: ownership mismatch

Started a third new TUI with only:
```sh
codex --no-alt-screen -C /private/tmp/cfind-codex-hook-probe-dck40szf/shared
```

- Test TUI PID: `44487` (returned by tmux pane_pid; shell used exec).
- Test pane: `%18`.
- Skipped the update prompt; no Codex installation was changed.
- Trusted only the scratch project and the eight authored diagnostic hooks via
  the TUI's normal `/hooks` review, without a bypass flag.
- Submitted: `Reply with exactly CFIND_SHARED_OK. Do not call tools or create subagents.`
- Observed reply: `CFIND_SHARED_OK`.
- Thread: `01a17d45-c4ee-7970-bfdc-5bb2f89d2efa`.

Observed hook evidence:

| event | hook PID | hook parent PID | hook TMUX_PANE | actual TUI PID/pane |
| --- | --- | --- | --- | --- |
| SessionStart | 48512 | 52798 | %5 | 44487 / %18 |
| UserPromptSubmit | 48523 | 52798 | %5 | 44487 / %18 |
| Stop | 48590 | 52798 | %5 | 44487 / %18 |

Parent chain:
```text
hook -> app-server worker 52798 -> app-server 42653
     -> older TUI 42560 -> its shell -> tmux server
```
The actual attached test TUI `44487` was not in that ancestry. Following
ancestors or trusting the hook's TMUX_PANE would associate this thread with an
unrelated existing TUI/pane. All three events reported the same wrong pane.

Input field names observed:
- SessionStart: session_id, transcript_path, cwd, hook_event_name, model,
  permission_mode, source.
- UserPromptSubmit: session_id, turn_id, transcript_path, cwd, hook_event_name,
  model, permission_mode, prompt.
- Stop: session_id, turn_id, transcript_path, cwd, hook_event_name, model,
  permission_mode, stop_hook_active, last_assistant_message.

No event contained a TUI PID, client PID, or pane field.

## Contract validation status

- Correct PID/pane/thread association in normal shared-daemon mode: FAILED.
- Thread id in hooks: available, as shown above.
- UserPromptSubmit and Stop events around the test turn: observed.
- Atomic production live-record write: not implemented after the failed gate.
- Exact procStart field: not implemented or validated.
- idle versus busy live-record transitions: not implemented or validated.
- Approval-menu waiting record: not attempted after the ownership gate failed.
- Deletion of a production record at exit: not applicable; no record was created.

Hooks run in the agent loop; they are not a documented TUI menu-state feed.
Even a future ownership solution must prove the contract's strict idle condition
(no menu open), rather than equating Stop with the final UI state.

Cleanup: `/quit` was sent only to the three TUIs created above. All three test
tmux sessions were verified to have exited. The pre-existing shared daemon and
user sessions were left running. Scratch evidence is retained for review.

## Required code checks

Executed from `ts/`:
```sh
npm run typecheck && npm test
```

Final result: type check passed; **81 tests passed, 0 failed**.
- Final log: `/tmp/cfind-codex-live-final.log`.
- Baseline also passed 81/81: `/tmp/cfind-codex-live-baseline.log`.
- Tests built the existing application as normal; no collector implementation was
  added. Concurrent changes by Claude can change future test counts/results.

## Supported alternative for Claude to evaluate

The installed CLI and official documentation provide:
```sh
codex queue --thread <SESSION_ID> --message <TEXT>
```

This may address sending messages without typing keys into a pane. This task
verified command help and official documentation only; it did not test queue
behavior or change the dashboard to use it. It does not supply the contracted
TUI-owner JSON record or replace an approval/menu-state integration. Changing
that dashboard path remains a separate decision for the user and Claude.

## Claude follow-up: `codex queue` evaluation (2026-10-27)

Probe threads only (`probe-cwd` in the Claude session scratchpad), each TUI in its own
detached tmux session, all closed after the test. CLI 0.163.0, shared daemon 0.164.0.

| case | result |
| --- | --- |
| thread open in a TUI, idle | `codex queue` returned in 56 ms; the message ran at once and showed in the TUI (`QUEUE-IDLE`) |
| thread open in a TUI, turn running (`sleep 10`) | queued; ran right after the running turn ended; a two-line message stayed one message (`QUEUE-BUSY 2`) |
| TUI closed, thread still held by the shared daemon (`lsof` shows the daemon PID on the rollout) | the daemon ran the turn with no TUI (`QUEUE-CLOSED`) |
| thread never loaded by the daemon (made with `codex --no-daemon`) | `Queued message ...`, exit 0, but nothing ran for 30 s; it ran when the thread was opened with `codex resume` (`QUEUE-COLD`) |
| turn that asks for escalation with no TUI attached | did not stall: this user's config is `approval_policy.granular.sandbox_approval = false`, so the request was rejected and the agent reported it |

Conclusions:
- `codex queue` is a documented way to send input to a live Codex thread. It needs no
  PID or pane mapping and has no risk of keys landing in a menu.
- It does not say whether the message ran or is waiting. A thread that the daemon has
  not loaded keeps the message until the next `codex resume`.
- With another approval config, a turn started with no TUI may wait for an approval
  that only a client can answer. Not tested.
