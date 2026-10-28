# Live dashboard and session chat: test record

Updated 2026-10-27. Machine: macOS, Node 24.18.1, Claude Code 2.1.311, Codex CLI 0.163.0 (0.164.0 for E21 to E23).
A copy lives in the private Notion test plan, sections G to M.

## Scope

- Collector, daemon, dashboard APIs, and the Apple-style browser UI.
- Session chat: IM-style transcript (agent left, user right; swapped 2026-10-27), Markdown and code,
  copy controls, tool details, message box, queue edits, approval and question cards,
  image attach (button, paste, drop) and images in bubbles.
- Claude stream-json and Codex app-server adapters.

## Build and run

```sh
cd ts
npm run typecheck
npm test                                   # builds first; needs loopback bind permission
node --check src/dashboard/dashboard.js
node --check src/dashboard/markdown.js
cd .. && git diff --check
```

Reload the daemon after a backend change. This keeps launchd supervision:

```sh
cd ts && npm run build
launchctl kickstart -k gui/$(id -u)/com.context-find.dashboard
node dist/cli.js daemon status
```

`daemon stop` also boots the job out of launchd. After it, `daemon start` runs
without supervision. Run `node dist/cli.js daemon install` to restore launchd. The
install is idempotent: both Claude `settings.json` files were byte-identical after a
second install on 2026-10-27.

Environment for tests: `CFIND_CLAUDE_BIN` and `CFIND_CODEX_BIN` select fake agent
binaries. `CFIND_DATA_DIR`, `HOME` and `CODEX_HOME` isolate data. Do not print the
token in `~/.context-find/dashboard/service.json`.

## Automated tests (98/98 pass, 2026-10-27)

| file | covers |
| --- | --- |
| `test/monitor.test.ts` | Codex cumulative deltas, Claude message-ID dedup, partial appends, profiles; a Claude session with a live PID in `sessions/*.json` is `open` even when idle, a dead PID is not; a record with a tmux pane sets `tmux`; a record in `<dataDir>/live` is read; status line limits and cost go to the profile that holds the transcript, not the hook's profile tag; a message ID copied into another file counts once per profile (owner = earliest session), deleting the owner moves the credit, a version 1 cache is ignored; titles lose paste tags, also a tag cut by the 220-character limit; Claude status `shell` (turn over, background shell tasks still running) is `running` |
| `test/collector.test.ts` | hook receiver, status-line wrapper, install idempotence |
| `test/dashboard_api.test.ts` | token, foreign Origin, POST JSON, SSE reconnect snapshot; `/api/conversation` token, outside path 403, symlink escape 403, missing 404; `/markdown.js` served. `/api/upload`: a PNG is saved as `<32 hex>.png`; SVG text sent as `image/png` 415, `text/plain` 415, over 10 MB 413; GET without token 403; served back with its content type and `nosniff`; `../` and encoded ids 400, unknown id 404 |
| `test/conversation.test.ts` | Claude: preambles, `isMeta`, sidechains, reminders and OSC 52 removed, tool_use paired with tool_result, code whitespace kept. Codex: AGENTS.md wrapper and developer messages hidden, calls paired by `call_id`, old JSON shell output, code-mode `cmd` extraction. A message typed while Claude works (`attachment` / `queued_command`, origin human) shows as a user message. Images: Claude `image` base64 blocks and Codex `input_image` data URLs come back as data URLs; other types and bad base64 are dropped; a message with only an image is kept; newest images fill an 8 MB budget, older ones become "[N image(s) not shown]". A user turn with `origin.kind = task-notification` becomes a note with its `<summary>` (none: hidden); `<pasted_content id=…>` tags are removed, the pasted text stays. Caps: newest 400 messages, `omitted` count, 8000-character tool text |
| `test/markdown.test.ts` | script, img onerror, svg onload, `javascript:` links, attribute breakout, fence breakout, table cells: all stay text. Fenced code keeps tabs and spaces; open fence while streaming; nested lists with code; tables; links; `__init__.py` unchanged |
| `test/live.test.ts` | fake tmux binary (`CFIND_TMUX_BIN`): send runs `display-message`, `load-buffer`, `paste-buffer -d -p -r`, `send-keys Enter`; control characters removed; refused when busy, waiting, PID start time differs, no pane, or the pane process is not the PID or its ancestor. Take over: refused in tmux or on a start-time mismatch; SIGTERM stops a verified child. Busy sends are allowed, also with status `shell`; a menu that opens between paste and Enter stops the Enter. Codex: fake `lsof` (`CFIND_LSOF_BIN`) and fake `codex`: no holder is `none`, `--listen stdio://` is `other`, `--listen unix://` is `helper`, missing lsof throws; `codex queue --thread --message` keeps newlines and drops NUL. Terminal view: `capture-pane -p` (no `-e`) with control characters removed, last 40 lines; `send-keys` only for Up, Down, Left, Right, Enter, Escape, Tab, BTab, Space, 1 to 9 and a to z; both work while the session waits and are refused on a start-time mismatch, no pane, or a pane that does not run the process |
| `test/agents.test.ts` | Codex queue order, decline, child agents. Claude fake binary: refuses to prompt unless `--permission-prompt-tool stdio` is set; AskUserQuestion answer keyed by question text; allow for session forwards only `session` suggestions; tool_result fills tool output; queue removal; answer shown as a user message. Codex fake: `requestUserInput` answers by question id, `acceptForSession`, command output and exit code, file change diff. Attached images: Claude gets `image` base64 blocks plus the text, Codex gets `localImage` items with the saved path; the user message keeps the upload ids |
| `test/devices.test.ts`, `test/iphone_contract.test.ts` | iPhone pairing and the fields the app decodes. See `feat_iphone_app_test.md` |

## Real end-to-end runs (2026-10-27)

Driven through the real UI with headless Chrome (playwright-core from the npx cache,
isolated profile). Working folder: the session scratchpad `probe-cwd`.

| id | case | result |
| --- | --- | --- |
| E1 | Claude default profile, Write tool | card "Allow Write?" with Decline, Allow edits this session, Allow once. Allow once created the file; tool row shows output. Pass |
| E2 | Claude AskUserQuestion | card with Tea and Coffee. One click on Coffee sent the answer; reply `ANSWER=Coffee`. Pass |
| E3 | Claude decline with instructions | typed reply while the Write card waited; file not created; reply `SKIPPED`. Pass |
| E4 | continue an inactive Claude session from its chat view | earlier messages kept, divider "Continued in the dashboard", new reply `CONTINUED`. Pass |
| E5 | active external session (this Claude Code session) | live chat view, message box read-only with the reason, no send button. Pass |
| E6 | Codex command approval (network outside sandbox) | card "Allow this command?" with the command; Allow once ran it; reply `HTTP/2 200`. Pass |
| E8 | Claude session idle in a terminal (`dbe658b7`, live PID) | `open: true`, state idle; `create` with its id returns "Resume requires an inactive local session"; message box read-only. Before the fix the box unlocked and would start a second process on the same session. Pass |
| E9 | send into a live tmux Claude session (probe TUI in its own detached tmux session `cfind-probe`, pane `%14`) | API: a two-line message arrived as one prompt, reply `PANE-OK 2`. UI: box "Message Claude · Default in its terminal…", hint switched to "Replying in its terminal…" while busy, reply `UI-OK-2` shown in the chat view and in the pane. No record exists while the trust dialog shows, so nothing can be sent then. Pass |
| E10 | Take over outside tmux (same probe resumed in tmux with `TMUX` and `TMUX_PANE` unset, record has no pane) | read-only with "Take over"; first click shows "Stop it in the terminal?"; second click: process exited 143 (SIGTERM); box unlocked; continue replied `TAKEOVER-OK` with earlier messages kept; transcript 84 lines, all valid JSON. Pass |
| E11 | Codex probe thread open in a helper-backed window, idle | box "Continue this conversation…"; send: toast "Sent to Codex"; `DASH-QUEUE` in the chat view and the window. Pass |
| E12 | same, window running `sleep 12` | box "Queue a message for Codex…"; toast "Queued after the current reply"; ran after `SLEEP2-DONE`. Pass |
| E13 | Codex thread open in a `--no-daemon` window | refused with "Open in a Codex window that does not use the background helper"; draft kept; message not in the rollout. Pass |
| E14 | same thread, window closed | no holder; dashboard continued it as its own agent; reply `DASH-CONTINUE`. Pass |
| E15 | Personal session started in the home folder (this one) | status line arrived tagged `claude` (home `~/.claude/settings.json` loads as project settings). Before: Personal card "Not available". After: Personal 42% / 20%, Default 3% / 34%. Pass |
| E16 | send while Claude works (probe TUI running `sleep 20`) | box "Message Claude · Default while it works…"; Claude absorbed it mid-turn and replied `SLEEP3-DONE MID-OK`; the message shows as a user bubble. Pass |
| E17 | cross-file dedup on real data | Default output 19,411,991, equal to an independent per-ID dedup of `~/.claude/projects` (1.73% removed); Personal 0.36% removed. Pass |
| E18 | `daemon stop`, then `daemon start` | job back in launchd (`state = running`); after `kill` of the PID launchd restarted it (`runs = 2`). Pass |
| E19 | dropdowns | page-styled list in light and dark, in the toolbar and inside the modal new-agent dialog; arrows, Enter, Escape, type-ahead, click; value and change event update. Pass |
| E20 | layout after the swap | dark 1512x1100: user bubbles 28 px from the right, agent bubbles and tool rows 28 px from the left. Pass |
| E21 | Claude dashboard agent (Default profile), red 64x64 PNG attached with the button | thumbnail in the tray, sent with "What colour is this image?"; reply `Red`; the image shows above my bubble (loaded from `/api/upload`); tray cleared. Pass |
| E22 | Codex thread open in a helper-backed TUI (0.164.0, own tmux session), same PNG | toast "Sent to Codex"; the TUI showed the text plus `Image: ~/.context-find/dashboard/uploads/<id>.png`, "Viewed image", reply `Red`. Pass |
| E23 | composer, light and dark | two images from the file picker and one pasted; a dropped `.txt` gives "Only PNG, JPEG, GIF and WebP images are supported"; × removes one; click on a chat image opens a centered viewer; Escape closes only the viewer, the chat and tray stay. Pass |
| E24 | real work session with task notices and a pasted prompt | title "refer to <client> AWS profiles…" (no tags), 0 titles with tags across all sessions; notices show as notes, e.g. `Background command "Deploy <stack> with CDK" completed (exit code 0)`. Pass |
| E25 | Agents board with 4 Claude sessions open in tmux (1 busy, 1 `shell`, 2 idle) | before: only this session showed; the work session (status `shell`, 7 background scans) showed "Unknown" and its box refused sends. After: Running = 2 (incl. the work session), Idle = 2; finished subagents of an idle session are hidden. Pass |
| E26 | open tab, then `launchctl kickstart -k` | before: the new run had a new URL token, the tab's stream got 403 and stayed "Reconnecting". After: the daemon keeps its token in `~/.context-find/dashboard/token` (0600); badge went Reconnecting, then Live, with no reload. Pass |
| E27 | ⌘B (Ctrl+B) in Chrome and in the Mac app | sidebar hides, content takes the width (`.shell` margin 0); again shows it; choice kept in `localStorage` `cfind-sidebar`. Pass |
| E28 | Agents board, an agent with 3 subagents | folded under "› 3 subagents"; click unfolds; stays open across board redraws (`S.openKids`). Long prompts wrap inside the card and clamp to 3 lines. Pass |
| E29 | page with a stub `window.webkit.messageHandlers.cfind` | opening a chat posts `session:<path>`; Escape posts an empty string (the Mac app uses this to skip banners for the chat on screen). Pass |
| E31 | Linear/Cursor style restyle (`dashboard.css`) | 13px base, 1px hairlines, 8px cards, mono for paths, models and numbers; dark and light at 1512 and 700 wide; no sideways overflow on any page. Pass |
| E32 | chat after the restyle (user: "improve spacing and contrast") | dark muted text #84848d, secondary #ababb4, lines 8% white, agent bubble #222226; messages 8px apart, bubbles 9x13 padding at 13.5px. Pass |
| E33 | message box alignment | one line: text box and buttons both 26px tall, same top; two lines: buttons sit on the last line (textarea 46px, attach top = textarea top + 20). Pass |
| E34 | ⌘K command menu and single-key shortcuts | ⌘K lists commands; typing "cfind" lists matching sessions (12 items); ↓ + Return runs one; `g s` goes to Sessions; `?` opens the shortcut list; no page errors (Chrome); the same in WKWebView. Pass |
| E30 | small glass sidebar, light, dark, and 700 px wide | floating pane 10 px from the edges, blur, 210 px wide; icons only under 760 px. Screenshots checked. Pass |
| E35 | message box at Mac zoom 0.9, 1, 1.1, 1.2 (WKWebView, `pageZoom`) | no sideways scrollbar; visible height 26 to 27 px (it was 12 px at 1.1, which cut the placeholder). Pass |
| E36 | full-screen chat header | header lines up with the chat column; home folder shows as `~`; the state dot sits level with the text. Screenshot checked. Pass |
| E37 | sidebar beside a full-screen chat | chat starts at the sidebar edge (218 px), sidebar stays visible; with ⌘B the chat uses the full width; sidebar 12 px from the window edge. Pass |
| E38 | ⌘1 to ⌘6 | ⌘3 → #sessions, ⌘4 → #usage, ⌘1 → #overview (Chrome, WKWebView native keys, Mac UI test). A full-screen chat closes when you change section. Pass |
| E39 | Esc on a full-screen chat | first Esc → side panel, second Esc → closed; the saved size stays full, so the next chat opens full screen. Pass |
| E40 | `/` menu in the message box (Chrome, live tmux chat, sending stubbed out) | `/` shows "Loading commands…", then 103 commands (about 4 s, once per profile and folder); `/comp` → compact first; ↑↓ moves; Tab and click fill `/name `; Esc closes only the menu; Enter on a full name sends; Enter on a part fills. Pass |
| E41 | terminal-only commands | `doctor`, `color`, `focus`, `reload-plugins` (Claude's `terminal_slash_commands`) show in a tmux chat and are hidden for dashboard agents and resumed chats. Pass (tmux side checked) |
| E42 | `GET /api/commands` | folder this profile never ran in → 403 "Unknown folder"; known folders → 200. Claude runs `-p /cost` with hooks and MCP off; no model call. Pass |
| E43 | unit tests (`test/commands.test.ts`) | descriptions from SKILL.md (folded), project commands, plugin commands; built-in text; `__` names hidden; one probe per folder; failed probe not cached; frontmatter edge cases. 101/101. Pass |
| E44 | chat stays still while typing (WKWebView, zoom 1 and 1.1, 3-line draft in a live chat, sending stubbed out) | before: the chat slid 20 to 40 px off the bottom on every key and live updates snapped it back. After: distance from the bottom stays 0 on every key; box 26/46/66 px. Pass |
| E45 | sidebar as a flap over the full-screen chat (replaces E37; Chrome 1512 and 1100 wide) | chat spans the whole window (drawer 0 to full width); the glass sidebar sits on top (hit test at x=100 finds the sidebar); the chat column stays clear of it (composer starts at 336 / 234 px). ⌘B slides it out (visibility hidden after 0.2 s, the column re-centres) and back. No page errors. Mac UI test not re-run: launching it quits the running cfind app. Pass |
| E46 | `cfind` is the service only (`ts/src/cli.ts`; ui.tsx, rows.ts, ink, react removed) | `cfind` → "Already running on port 4319" (exit 0); `cfind daemon status` → running + URL; `cfind ebs` → exit 1 "cfind no longer searches in the terminal…dashboard"; `cfind --json` → exit 1 unknown option; `--help` lists only the service, machines and onboarding options; `--list-machines` prints the table. Pass |
| E47 | the LaunchAgent still starts with the new CLI | `launchctl kickstart -k` → service runs (`cli.js service run --local` from the old plist; `--local` accepted and ignored); dashboard 200. New plists drop `--local`. Pass |
| E48 | the service reads `~/.context-find/hosts` (before: only `cfind web` did; the service ran local-only) | code path: `serveWeb(readHosts(), …)`. Remote search in the dashboard not run: the only host (macmini) does not resolve today. Not tested |
| E49 | (replaced by E60) ⌘⇧F toggles the open chat between full screen and side panel (Chrome) | full → panel → full, also while typing in the message box; listed in the ? shortcuts. In the Mac app not run (the UI test would quit the app in use); no standard macOS menu item uses ⇧⌘F. Pass in Chrome |
| E50 | a command typed in Claude Code's terminal (`/model`, a bare `/`) | before: Claude's output "Commands are in the form `/command [args]`" showed as your blue bubble. Now records that share a `<local-command-caveat>` promptId, plus `<command-name>` and `<local-command-stdout>` records, show as one grey line: "/model opus: Set model to Opus 5.5"; empty output adds nothing; real prompts after it stay bubbles. Unit test. Pass |
| E51 | terminal card, API (scratch Claude TUI in its own tmux session `cfind-probe`, never the user's panes) | `/model` sent with live-send → state `waiting`; `GET /api/live-screen` returned Claude's picker as plain text (no control characters); key `Down` changed the screen; `Escape` closed it → `idle`. Key `C-c` → "Unknown key"; unknown sid → 404; no token → 403. Pass |
| E52 | terminal card, UI (Chrome, same probe) | `/mo` lists `model`; `/model ` shows no model list in a tmux chat (Claude's own picker opens instead); Enter → card opens by itself, header button pressed, hint "Answer in the terminal view above…"; click the screen, ArrowDown changes it, the ↑ button restores it; Esc goes to the terminal and does not close the chat; card closes itself when the session is idle; header button opens it by hand, × hides it. No page errors. Pass |
| E53 | `/model <name>` for a dashboard Claude agent (fake binary) | sends `control_request` `set_model` (no model for `default`); success → note "Model set to claude-sonnet" and the header model changes; error → "Could not change the model: …"; nothing is queued. The real CLI answered `set_model` the same way with a scratch `CLAUDE_CONFIG_DIR` (no settings file written). Picked model is passed as `--model` if Claude starts again. Pass |
| E54 | (recents part reverted in E59) glass sidebar (Chrome, 1400 px, light and dark) | flush to the window's top, left and bottom edges, frosted over a soft tint; rows: sidebar button + cfind, New agent ⌘N, Search ⌘K, 5 sections, recent conversations by project (10 projects, 40 rows, foldable, fold kept after reload, the open chat is highlighted), status and Connections at the bottom; no sideways scroll. Pass |
| E55 | full chat beside the sidebar | full chat starts at the sidebar's right edge (240 px) instead of under it; ⌘B or the sidebar button slides the sidebar away and the chat takes the whole window; the button stays in place; top rows make room for it. Side panel unchanged (880 px from the right). Pass |
| E56 | Mac app contract, simulated in Chrome (`mac-app` class, `--mac-lights: 84px`, `--mac-bar: 52px`, fake `webkit.messageHandlers`) | brand hidden, sidebar button at 84 px after the window buttons, top rows 52 px; click on empty top bar, sidebar top or chat header → `window:drag`; double click → `window:zoom`; buttons send nothing; `theme:light`/`theme:dark` on load and on each switch. Pass (native side: see cfind-apple) |
| E57 | narrow window (700 px) | 80 px icon sidebar, recents and shortcut hints hidden, sidebar button centered over the icons, top bar 48 px like the sidebar row. Pass |
| E58 | Usage & analytics page removed; its input, output and cache figures moved to Overview's usage panel (Total, Input, Output, Cache "read · written", Sessions on one row at 1140 px). The Models panel, tokens-by-project table and API value are gone with it (they were only on that page). `#usage` opens Overview; ⌘1-⌘4 and G O/A/S/M follow the 4 sections. Pass |
| E59 | sidebar back to the sections only: no recent-session list (E54 reverted) and no app name in the top row, as in the Claude app; New agent and Search stay. Pass |
| E60 | ⌘⇧F: the page no longer toggles the chat; the Mac app menu View → Full Screen (⇧⌘F) makes the window full screen. In Chrome ⌘⇧F does nothing in the page; the shortcuts list shows the row only in the Mac app. Mac app not run yet (needs install). Pass in Chrome |
| E7 | before the fix: Claude print mode without `--permission-prompt-tool stdio` | Write denied with no prompt. This was the old browser adapter behavior |

Personal Claude profile inference was not tested; it reported "out of usage credits"
in an earlier run and again on 2026-10-27 (E21 ran on Default).

## Browser layout checks (2026-10-27)

- Desktop 1512x1100 light and dark: user bubbles 28 px from the left edge, agent
  bubbles 28 px from the right edge, no horizontal page overflow.
- Mobile 390x844 light and dark: chat uses the full width, no element wider than the
  viewport outside scrollable code and tables.
- No page errors or console errors in any run.

## Performance

| transcript | `/api/conversation` |
| --- | --- |
| 147 MB Claude | 456 ms, 589 KB response, 400 shown, 1162 omitted |
| 77 MB Claude | 347 ms |
| 67 MB Claude | 225 ms |

A followed live session reloads its transcript at most once every 3 seconds.

## Known limits

- Input to a live terminal session works only through tmux (Claude records the pane in
  `sessions/<pid>.json`). Outside tmux the only option is Take over. `claude attach`
  covers background sessions only.
- tmux send appends to any draft typed in the terminal input box. A message sent mid-turn shows in the chat only after Claude absorbs it. Status "idle" can
  still have an overlay open (for example a slash-command picker); Enter would act on it.
- A bare pty (no terminal emulator) gets no session record; Claude waits for terminal
  replies. Real terminals and tmux are fine.
- Codex hooks run in the shared helper, so they cannot name the window or PID (see
  `feat_codex_live_record_test.md`). Codex input uses `codex queue` instead, chosen by
  `lsof` on the session file (works, but the helper's open-file behavior is not
  documented).
- A Codex session the dashboard continued itself (E14) runs in the dashboard's own
  app-server. Opening it in a Codex window at the same time gives two writers.
- Codex sessions open in a terminal are not detected while idle. Codex 0.164 runs
  threads in a shared `codex app-server daemon`; joining it is not tested or used.
- Images reach Codex queue and tmux sends as a path line in the text. The agent opens
  the file itself; the chat shows that line, not a picture.
- Uploads stay in `~/.context-find/dashboard/uploads` (mode 0600) and are removed after
  30 days, on the next upload. A queued or sent message whose file was removed shows no
  image.
- Claude transcripts store images inline, so the chat shows them; the 8 MB image budget
  per response can hide older ones.
- The chat view shows the newest 400 transcript messages. There is no "load earlier".
- Each live reload reads the whole transcript file (see Performance).
- Remote sessions use the plain line view and are read-only.
- Workspace agent memory keeps the newest 250 messages per agent.
- Codex `item/tool/requestUserInput` and MCP elicitation were tested only with the
  fake binary. Real Codex asks such questions rarely (mostly in plan mode).
- Claude "allow for this session" forwards only session-scoped suggestions. Rules that
  write to settings files stay in the terminal.
- After a daemon restart, workspace agents show "Stopped". The next message resumes
  the session.
- The daemon's URL token no longer changes on restart. Delete
  `~/.context-find/dashboard/token` and restart to get a new one (open tabs then need
  `cfind web` again).
- Claude's `shell` status is not documented. Its meaning (turn over, background shell
  tasks still running) comes from Claude Code 2.1.311's status list and one real session.

## Test leftovers

- Workspace cards from the runs above (ui-probe Claude agent, Codex curl agent,
  continued probe session, and older "dashboard connection test" cards). Remove them
  with "Remove card". Their transcripts stay in the tool stores.
- `probe-cwd/ui-probe.txt` and `probe-b.txt` in the session scratchpad.

## Rerun before you change this area

1. `npm test` in `ts`.
2. Reload the daemon with `launchctl kickstart -k`, then `daemon status`.
3. In the browser, open one Claude and one Codex session: check left/right alignment,
   code copy, tool expand, and find.
4. Run E1 to E3 with the default Claude profile and E6 with Codex. Each costs one short turn.
5. Check desktop and mobile widths in light and dark.
