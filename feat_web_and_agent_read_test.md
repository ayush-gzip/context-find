# feat: `--json`, `show`, `web` (agent-read + browser view)

v1 of the hermes/agent read path plus a read-only browser view. Resume/terminal
interaction is deferred to v2.

## What was built

- `cfind --json [query]` — search results as JSON (array of sessions + host errors).
  Forces non-interactive even on a TTY. For scripts/agents.
- `cfind show <path> [--host SSH] [--width N]` — cat one session's full rendered
  transcript to stdout (`showAll=true`, so tool output/reasoning included).
  Local by default; `--host <full spec>` renders a remote session over ssh via
  the existing `renderRemote` / store.py `--render` op.
- `cfind web [--port N]` — localhost-only HTTP server + single-page browser view.
  Search list + reader. No resume. Endpoints: `/`, `/api/search`, `/api/session`.

## Files touched

- `ts/src/cli.tsx` — flags (`--json --width --port`), `show`/`web` subcommand
  dispatch, `printSessionsJson`, `printSessionTranscript`; json branch in the non-interactive path.
- `ts/src/web.ts` — new. http server + inline HTML page.
- No change to `store.ts`, `store.py`, or the golden test (pure reuse of
  `Search`, `render`, `renderRemote`).

## Build / run

```
cd ts
npm run typecheck        # tsc --noEmit
npm test                 # 38 tests incl. cross-language golden (needs python3)
npm run build            # tsc + copies store.py into dist/
```

## Security model (web)

- Socket binds `127.0.0.1` only. Transcripts hold secrets; never off-machine.
- Per-run 32-hex token required on every `/api/*` call. A cross-origin page in
  the browser cannot read the token (SOP), so it cannot drive the corpus even
  though the port is open.
- `Host` header must be localhost.
- `/api/session` local path must resolve under a known transcript root
  (`projectsRoots()` + `codexRoots()`); remote host must be in the hosts list.

## Test cases (all verified 2026-08-23, macmini host reachable)

| case | command | expected | actual |
|---|---|---|---|
| json valid | `cfind --json effdog` | valid JSON, sessions>0, keys incl. path/host/sid | 310 sessions, all keys ✓ |
| json local host | (above) | `host:null` for local rows | ✓ |
| json remote | `cfind --json kite` | remote rows have full host spec + hostLabel | 293 remote, spec=`macmini # context-find:os=posix` ✓ |
| show local | `cfind show <codex path>` | full rendered transcript, tool output shown | 1931 lines ✓ |
| show remote | `cfind show <path> --host "macmini # context-find:os=posix"` | remote transcript over ssh | 73 lines ✓ |
| show no path | `cfind show` | usage error, exit 1 | ✓ |
| web boot | `cfind web --port N` | prints URL, binds localhost | ✓ |
| web search+token | `GET /api/search?t=TOKEN&q=effdog` | JSON sessions | 310 ✓ |
| web no token | `GET /api/search?q=kite` | 403 forbidden | ✓ |
| web session read | `GET /api/session?t=TOKEN&path=<valid>` | lines array, styled | 681 lines ✓ |
| web path guard | `GET /api/session?t=TOKEN&path=/etc/passwd` | 403 outside stores | ✓ |
| web machines API | `GET /api/machines?t=TOKEN` | `{machines:[...]}` local + each host, counts/last/status | this machine 290 + macmini 318 ✓ (2026-08-25) |
| web machines view | click "☰ machines" link | table renders in reader pane | ✓ |
| web search button | type query, click ↵ button | list filters to matches | prowler→25, kite login→56 ✓ |
| web search Enter | type query, press Enter (form submit) | list filters | requestSubmit→25 ✓ |

Getting the token in a test: `curl -s http://127.0.0.1:PORT/ | grep -o 'const T = "[a-f0-9]*"'`.

### Search precision fix (2026-08-25)

- **Bug:** searching `karpenter` returned 39+ unrelated sessions. Root cause:
  `scanLocal`/`scan_local` matched the raw transcript, including injected
  `type:"attachment"` entries (skill catalogs, hook/token/system reminders).
  The `aws-containers` skill blurb mentions "Karpenter" and is injected into
  nearly every session, so almost everything matched.
- **Fix:** exclude `attachment` entries from the search corpus in both
  `store.ts` (`searchText`/`isAttachment`) and `store.py`
  (`_search_text`/`_is_attachment`). Message text and tool output live in
  user/assistant entries and stay searchable; the empty-query fast path (no
  file read) is preserved.
- **Verified:** `karpenter` 39 → 8 (all 8 genuinely EKS/karpenter sessions);
  `prowler-output` → 2 (tool-output filenames still match); empty → 598 (all);
  38/38 unit tests green including the TS/Python golden parity test.
- **Known residual:** `<system-reminder>` / memory-context blocks that ride
  *inside* user-message entries (not attachments) are still searched, so a term
  appearing only in injected memory context can still over-match. Separate,
  smaller issue - not addressed here.

### Search scope - real chat only (2026-08-25, final)

- **Decision (per Ayush):** "context find not bullshit find - only real chat."
  Search matches **only user + assistant message text**. Excluded: tool calls,
  tool output, reasoning, and every injected block (skill catalogs, system
  reminders, Codex `developer`/`system`/`world_state`/`turn_context`, session
  preambles).
- **Implementation:** replaced the denylist (`isInjected`/`INJECTED_MARKERS`)
  with an allowlist `searchText(path, source)` in store.ts / `_search_text` in
  store.py. Claude: `user`/`assistant` entries via `plainText`, user turns
  stripped of `<system-reminder>` spans and skipped if they start with a
  SKIP_PREFIX. Codex: `response_item` `message` user/assistant via `codexText`,
  user turns skipped on CODEX_SKIP_PREFIXES. Empty-query browse stays read-free.
- **Tradeoff (intended):** a term that only ever appeared in tool output (a
  filename from `ls`, an error string, a command) no longer matches. If that
  ever bites, reintroduce tool-output as an opt-in `--all`/deep mode.
- **Verified:** TS == Python for every probe (`elastic` 20, `karpenter` 6,
  `kubernetes` 6, `kite login` 11, `prowler-output` 2); 38/38 tests green
  (store.test.ts updated to assert chat matches and tool/preamble text does
  not; golden parity test still agrees).

### Search precision fix, part 2 - Codex injected context (2026-08-25, superseded by the section above)

- **Symptom:** `elastic` (and `kubernetes`, etc.) matched ~every Codex session.
- **Cause:** the attachment fix (part 1) was Claude-only. Codex carries its
  injected instructions + skill catalog in `role:"developer"`/`"system"`
  messages and in `world_state` / `turn_context` entries. The `aws-containers`
  skill blurb ("...Elastic Kubernetes Service...") sits there, so any of its
  words matched everything.
- **Fix:** generalized the search filter (`isInjected`/`_is_injected` +
  `INJECTED_MARKERS`) in store.ts and store.py to drop, from the search corpus:
  Claude `attachment`; Codex `world_state`, `turn_context`, and
  `developer`/`system` messages. Tool output, `agent_message`, assistant/user
  messages, and reasoning stay searchable.
- **Verified via CLI** (`cfind <q> --local --list`): `elastic` codex 57 → 30
  real (survivors are tool output / assistant / user text about AWS); combined
  local TS == PY == 54 (parity); a known false hit (horse-tinder "connector for
  agents", `01a02cb2`) is excluded; `karpenter`→8, `kubernetes`→27 still work;
  38/38 tests green.

### Codex preamble fix (2026-08-25)

- **Symptom:** codex results showed weak summaries (dots / the plugin list) and
  the reader opened with Codex's session-start boilerplate.
- **Cause:** Codex injects one combined first user message starting with
  `<recommended_plugins>` (then `# AGENTS.md instructions`, `<INSTRUCTIONS>`,
  `<environment_context>`). `<recommended_plugins>` was not in
  `CODEX_SKIP_PREFIXES`, so `startsWithCodexSkipped` returned false and both
  `codexHeader` (summary) and `renderCodex` (reader) kept the whole block.
- **Fix:** added `<recommended_plugins>` to `CODEX_SKIP_PREFIXES` in store.ts
  and store.py. One prefix fixes summary + reader (both call the same helper).
  `show` (showAll=true) still renders the preamble - only the browse/read views
  hide it.
- **Verified:** summary → real prompt ("I am working on this problem..."); reader
  first turn → real "You" message; 38/38 tests green.
- **Note:** search still includes the codex preamble text, but it only exists in
  ~2 recent sessions, so plugin-name terms (`Higgsfield`) match just those 2 -
  negligible; not filtered. `elastic` matching 57 codex sessions is legitimate
  (AWS names: ElastiCache, Elastic Load Balancing, ECS/EKS), not noise.

### Web UI additions (2026-08-25)

- Search is now a `<form id="bar">`; submit (Enter in the field OR the ↵ button)
  runs `search()`. Replaced the prior invisible keydown-only trigger — a bare
  `input` + `keydown Enter` did not reliably submit; the form does, natively.
- `↵` button (`#go`, `type=submit`) sits right of the input.
- `☰ machines` link (`#mach`) calls `/api/machines` and renders the machine
  table in the reader pane (mirrors the TUI `--list-machines` view).
- `/api/machines` reuses `counts()` (local) + `countsRemote`/`recordPing`/
  `lastPingedAt`/`ago` (remote); same token+localhost guard as other `/api/*`.
- Harness note: the browser-automation `key: Return` does NOT emit a trusted
  keypress, so Enter-via-tool shows no filtering. Verify Enter with the button
  click or `form.requestSubmit()` — both confirmed working.

## Edge cases / notes

- web reader defaults `showAll=false` (mirrors TUI reader); `show` uses
  `showAll=true`. Same session renders fewer lines in web (noise hidden) than in
  `show` — intended, not a bug.
- `timeout` is not on macOS; don't use it in test scripts here.
- A huge pasted-article summary can be ~15k chars in one `summary` field; naive
  line-buffered JSON consumers may choke. cfind's output is valid; validate with
  `python3 -m json.tool` / jq, not a hand-rolled parser.
- Subcommand dispatch is positional: a literal search for the word "show" or
  "web" as the first arg is shadowed. Acceptable; quote differently if needed.

## Re-run before touching this area

`npm run typecheck && npm test`, then the two smoke checks: `cfind --json x | python3 -m json.tool >/dev/null`
and boot `cfind web`, curl `/api/search` with and without the token.
