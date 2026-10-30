# Agent mode switch (Shift+Tab) and `!` commands - test plan

Notion: "context-find test plan", section S.

## What it does

- Dashboard agent chats (web, Mac app, iPhone) show a mode button: **Auto** (runs commands without asking) or **Ask first** (asks before each command). Shift+Tab in the message box or a click switches it.
  - Claude: a running agent gets a `set_permission_mode` control request (`auto` or `default`). Claude answers with a `system` `status` event that carries `permissionMode`; that event sets the mode, so the button shows what Claude really uses. Without a running process the mode is stored and used for the next start (`--permission-mode`).
  - Codex: the mode is sent once as `approvalPolicy` on the next `turn/start` (`untrusted` = Ask first, `on-request` = Auto). Codex keeps it for later turns. A running Codex turn keeps its old policy; a note says the change starts with the next message. A resumed or attached thread shows the policy Codex reports.
- `! command` in an agent chat runs in the agent's folder.
  - Claude: the daemon runs `$SHELL -lc` (2 minute limit, 30000 characters per stream, own process group). The chat shows a Shell row `! command` with the output. The next message to Claude starts with `<bash-input>` and `<bash-stdout>`/`<bash-stderr>` blocks, the same format Claude's terminal writes. Commands keep the order they were typed; one that is still running goes with a later message.
  - Codex: `thread/shellCommand` (Codex records it in its thread). The row shows `! command`.
- Terminal (tmux) chats: Shift+Tab sends BTab to the pane; `!` text is typed in and the terminal runs it.
- `!` before an agent exists (first message in an old session) is refused: send a message first.

## Commands

```sh
cd ts
npm run build && npm test          # 105 tests incl. Codex's uncommitted ones
node --test --test-name-pattern="Shift\+Tab|Codex mode" --loader ./test/typescript-loader.mjs test/agents.test.ts
launchctl kickstart -k gui/$(id -u)/com.context-find.dashboard
```

iPhone build: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild build -project cfind.xcodeproj -scheme cfind -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO`.

## Protocol facts (probed 2026-10-28)

- Claude 2.1.312, before any user message: `{"type":"control_request","request_id":"r1","request":{"subtype":"set_permission_mode","mode":"auto"}}` returns `control_response` success `{mode:"auto"}`, then `{"type":"system","subtype":"status","permissionMode":"auto"}`. `manual` is not a control mode; use `default`. A bad mode returns `subtype:"error"`, `error_code:"invalid_mode"`.
- Codex 0.164 `thread/shellCommand {threadId, command, timeoutMs}`: emits `turn/started`, `item/started` `commandExecution` with `source:"userShell"`, `command:"/bin/zsh -lc '...'"`, `commandActions[0].command` = the typed text, then `item/completed` with `aggregatedOutput`, then `turn/completed`. Runs without the sandbox. Works on a scratch `CODEX_HOME` without sign-in.
- Codex `turn/start.approvalPolicy`: "Override the approval policy for this turn and subsequent turns." `thread/resume` and `thread/start` return `approvalPolicy`.
- Codex 0.164 has no `thread/settings/update` method (used by the uncommitted Codex `/model` and `/effort` code).

## Test cases

| # | Case | Expected | Result |
|---|------|----------|--------|
| 1 | New Claude agent | init reports auto; button Auto | pass (unit) |
| 2 | setMode manual, then auto | status events flip the mode | pass (unit) |
| 3 | Claude refuses a change | note "Could not change the mode: ...", mode unchanged | pass (unit) |
| 4 | setMode "plan" | Unknown mode | pass (unit) |
| 5 | `! sleep 0.3; echo hi && echo 'a<b' >&2`, `!true`, 40000-char output | rows in typed order; `(no output)`; context in typed order, escaped, capped at 30000 | pass (unit) |
| 6 | `!  ` / `! ls` with images | errors | pass (unit) |
| 7 | `! sleep 0.4; echo late` then a message at once | message goes without it; next one carries it | pass (unit) |
| 8 | Mode change with no Claude process | stored; next start uses it | pass (unit) |
| 9 | Codex: mode change | `approvalPolicy` on the next turn only once | pass (unit) |
| 10 | Codex `! ls` | `thread/shellCommand`; row `! ls` with output | pass (unit) |
| 11 | Codex resume | mode from `thread/resume` approvalPolicy | pass (unit) |
| 12 | Workspace close with `! sleep 371 & sleep 372` running | whole process group gone | pass (manual script) |
| 13 | Web: Shift+Tab, click, `!` hint, `! ls` output, next message context, no page errors | as described | pass (headless Chrome, scratch server, fake Claude) |
| 14 | `!` as the first message of an old session | refused with "Send a message first" | pass (headless probe) |
| 15 | iPhone build with mode button | builds | pass |

## Re-run before touching this area

- Both unit tests above, and `mode-probe.mjs` (scratch server + fake Claude + headless Chrome, `node --loader ./test/typescript-loader.mjs mode-probe.mjs <ts dir> <out dir>`).
- Probe a new Claude CLI version with a bare `set_permission_mode` request before changing the mode names.

## Not covered

- The 2 minute timeout path (same kill as case 12, not waited for in tests).
- A real Codex turn after a mode change (Codex sign-in was not working on 2026-10-28; the fake follows the probed schema).
- iPhone UI on a device (the user installs builds).
