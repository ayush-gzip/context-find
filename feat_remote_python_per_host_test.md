# feat: per-host remote python (drop CONTEXT_FIND_REMOTE_PYTHON)

## What changed
Replaced the process-wide `CONTEXT_FIND_REMOTE_PYTHON` env var with a per-host
`python=` field stored in the hosts file, collected during onboarding.

Old design: one env var, read locally, applied to every host, and it silently
overrode the per-host `os=windows` interpreter choice.

New design: each host line carries its own optional interpreter, e.g.
`build-box -i ~/.ssh/key # context-find:os=posix python=/opt/py/bin/python3`.
Resolution order in `remoteAgentCommand`:
1. the spec's `python=` field, else
2. `py -3` for an `os=windows` host, else
3. `"$(command -v python3 || command -v python)"` (autodetected on the remote).

## Files touched
- `ts/src/remote.ts` — `buildHostSpec` gains a `python` arg; new private
  `specPython(spec)`; `remoteAgentCommand` drops the env `override` param;
  `splitSpecTokens` strips the optional ` python=…`; both `os=windows` regexes
  loosened from `\s*$` to `(?:\s|$)` so a trailing `python=` still matches.
- `ts/src/cli.tsx` — `onboardExternalHost` asks "Remote python command (blank to
  autodetect)" and passes it to `buildHostSpec`.
- `src/context_find/store.py` — removed `REMOTE_PYTHON` env read; the whole
  remote-fan-out cluster (`machines`, `Search`, `scan_all`, `_run_remote_agent`,
  `read_hosts`, `host_display_name`, `build_ssh_argv`, remote scan/render) was
  later deleted as dead code — store.py is only the scanner shipped over ssh, the
  TS side does the fan-out.
- `README.md` — removed the `export CONTEXT_FIND_REMOTE_PYTHON` guidance; documents
  the `python=` field instead.
- `ts/test/store.test.ts` — updated `remoteAgentCommand` casts (no `override`);
  swapped the override test for a `python=` spec test; added `buildHostSpec` and
  `splitSpecTokens` `python=` cases.

## Build / run
- `cd ts && npx tsc --noEmit`
- `cd ts && npm test`   (Node test runner; golden tests shell out to `python3`)
- `python3 -m py_compile src/context_find/store.py`

## Test cases (all in ts/test/store.test.ts, passing)
- `buildHostSpec("mini","","posix","/opt/py/bin/python3")` →
  `mini # context-find:os=posix python=/opt/py/bin/python3`.
- `remoteAgentCommand("mini",["--counts"])` → POSIX autodetect string.
- `remoteAgentCommand("box # context-find:os=windows",["--counts"])` → `py -3 …`.
- `remoteAgentCommand("box # context-find:os=posix python=/opt/py/bin/python3",["--counts"])`
  → `/opt/py/bin/python3 …`.
- `splitSpecTokens("box # context-find:os=posix python=/opt/py")` → `["box"]`
  (marker + python stripped before building the ssh argv).

## Edge cases / notes
- `python=` value may contain spaces (`py -3`); the regex captures to end of line.
- The `python=` field is stripped from the ssh argv (only used to build the remote
  command), so it never leaks into ssh options.
- Windows hosts can also pin a custom `python=`; it wins over the `py -3` default.
- Manual hosts-file edits work too — onboarding is just the guided path.

## Re-run before touching this area
`cd ts && npm test` and confirm the four `remoteAgentCommand`/`splitSpecTokens`
cases above still hold; verify no `CONTEXT_FIND_REMOTE_PYTHON` reference has crept
back (`grep -rn CONTEXT_FIND_REMOTE_PYTHON`).
