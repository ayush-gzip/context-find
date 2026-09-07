# context-find

```
┏━╸┏━┓┏┓╻╺┳╸┏━╸╻ ╻╺┳╸   ┏━╸╻┏┓╻╺┳┓
┃  ┃ ┃┃┗┫ ┃ ┣╸ ┏╋┛ ┃    ┣╸ ┃┃┗┫ ┃┃
┗━╸┗━┛╹ ╹ ╹ ┗━╸╹ ╹ ╹    ╹  ╹╹ ╹╺┻┛
```

Search every Claude Code and Codex conversation you have ever had, across every
working directory and every machine, then jump back into one.

```
context-find "fargate arm64"
```

---

## Contents

- [The problem](#the-problem)
- [Install](#install)
- [Quick start](#quick-start)
- [Command reference](#command-reference)
- [The interface](#the-interface)
- [Two agents](#two-agents)
- [Other machines](#other-machines)
- [Safety](#safety)
- [How it works](#how-it-works)
- [The remote agent](#the-remote-agent)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## The problem

Claude Code's `--resume` only lists sessions for the directory you launched it
from. Codex's picker behaves the same way. So the conversation where you solved
something is findable only if you remember which of your project folders you
were in, and which tool you were using, and which machine you were sitting at.

Most people do not remember. They remember a phrase from the conversation.

`context-find` searches the transcript text of every conversation from both
tools, in every directory, on every machine you can reach, and puts you back
inside the one you meant.

---

## Install

Built on Ink, in TypeScript. Not published yet, so install from a clone.
Installs `context-find` and the short alias `cfind`. Needs Node 18 or newer.

```sh
git clone https://github.com/ayush-gzip/context-find
cd context-find/ts
npm install && npm run build && npm install -g .
```

Windows, macOS and Linux all work. On Windows use Windows Terminal or any
VT-capable console; a legacy `cmd.exe` falls back to ASCII box drawing
automatically.

---

## Quick start

```sh
context-find                       # browse everything, newest first
context-find "ebs snapshot"        # conversations whose transcript contains that text
context-find --codex "kite"        # Codex only
context-find --list-machines       # what is reachable, and what it holds
```

Inside the browser: type to narrow, arrows to move, `v` or `tab` to read,
`enter` or `r` to resume, `esc` to leave.

---

## Command reference

```
context-find [query] [options]
```

| argument | meaning |
| --- | --- |
| `query` | text to find anywhere in a transcript. Omit it to browse everything. |

| option | meaning |
| --- | --- |
| `--claude` | only Claude Code conversations |
| `--codex` | only Codex conversations |
| `--host SSH` | also search this ssh host. Repeatable. |
| `--local` | ignore the hosts in `~/.context-find/hosts` |
| `--onboard-external` | add an SSH machine interactively |
| `--debug` | print application diagnostics to stderr |
| `--list` | print results as plain text instead of opening the browser |
| `--list-machines` | show every machine that can be searched, and what it holds |
| `-h`, `--help` | usage |

With no `--claude` or `--codex`, both are searched.

`--list` output is designed to be piped. Each result prints its location, its
first prompt, and a copy-pasteable command that resumes it:

```
2026-08-11 09:43  codex   ~/Documents/Work/EffDog  [-]
  kite login
  cd /Users/ayush/Documents/Work/EffDog && codex resume 019fef02-9ecc-7bb0-8f8c-c3af852b6cd6
```

The browser is skipped automatically when output is not a terminal, so
`context-find ebs | less` and cron jobs behave.

### `--list-machines`

```
  machines context-find can search

  ╭────────────────────┬────────┬───────┬───────┬──────────────┬───────────────╮
  │ MACHINE            │ CLAUDE │ CODEX │ TOTAL │ LAST USED    │ STATUS        │
  ├────────────────────┼────────┼───────┼───────┼──────────────┼───────────────┤
  │ this machine       │    189 │   136 │   325 │ 1 second ago │ ready         │
  │ ayush@192.168.1.10 │    315 │     3 │   318 │ 4 weeks ago  │ ready in 0.3s │
  │ build-box          │      - │     - │     - │ -            │ unreachable   │
  ╰────────────────────┴────────┴───────┴───────┴──────────────┴───────────────╯

  643 conversations across 2 machines
  build-box did not answer: ssh: connect to host build-box port 22: Operation timed out
```

`LAST USED` is the most recent conversation on that machine, which tells you
whether a box is still in play. `STATUS` carries the round trip time, so a slow
host is visible before it slows a search down. Failure messages print below the
table rather than inside it, so a long ssh error cannot distort the columns.

Exits non-zero if any machine failed to answer, so it works as a health check.

---

## The interface

**List screen**

| key | action |
| --- | --- |
| `/` | enter search mode; type to narrow the visible rows |
| `j` `↓` | move down |
| `k` `↑` | move up |
| `PgUp` `PgDn` `Home` `End` | jump |
| `enter` `r` | resume the selected conversation |
| `v` `tab` | open/read the conversation |
| `l` | open the in-app `list-machines` view |
| `esc` | quit |

In search mode, `esc` returns to normal mode. Each row shows when it was last
active, the agent, the machine (`local` for this machine), the working
directory, the git branch, and the first real thing you typed.

In the `list-machines` view, `q`, `h`, left arrow or `esc` returns to the
conversation list.

The search argument and the live filter do different jobs. The argument matches
**raw transcript text**, so it finds anything anyone said, including tool
output. Pressing `/` and typing in the list applies an instant second filter to
the rows already found, matching only what is visible in the row.

**Reader screen**

| key | action |
| --- | --- |
| `j` `↓` | scroll down |
| `k` `↑` | scroll up |
| `PgUp` `PgDn` `space` `Home` `End` | scroll by page |
| `t` | show or hide tool results, reasoning and injected preambles |
| `enter` `r` | resume this conversation, in its own directory, with its own tool |
| `q` `esc` | back to the list |

The reader shows a rendered conversation, not raw JSON: speaker rules, wrapped
text, and tool calls collapsed to one line each.

---

## Two agents

Claude Code and Codex both keep local transcripts, in different places and
different formats. `context-find` reads both, shows them in one list with a
coloured badge per row, and hands each back to the tool that owns it.

| | Claude Code | Codex |
| --- | --- | --- |
| store | `~/.claude/projects` | `~/.codex/sessions` |
| override | `CLAUDE_CONFIG_DIR` | `CODEX_HOME` |
| layout | one file per session | `rollout-<time>-<uuid>.jsonl`, by date |
| session id | the file name | `session_meta.session_id` |
| turns | flat `type: user` records | `response_item` envelopes |
| git branch | recorded | not recorded, shown as `-` |
| resume | `claude --resume <id>` | `codex resume <uuid>` |
| noise hidden behind `t` | `<system-reminder>`, hook output, slash-command wrappers, IDE notices | `# AGENTS.md instructions`, reasoning blocks, inter-agent messages |

A scan reads both agents in one pass, and `--claude` / `--codex` filter the
finished list. Discovery, scanning and the ssh protocol have no notion of a
selected agent, so there is one code path rather than a mode threaded through
every layer. Reading both costs nothing measurable: a full local scan of 325
transcripts takes about a fifth of a second.

---

## Other machines

Put one ssh target per line in `~/.context-find/hosts`:

```
# ~/.context-find/hosts
mini
ayush@192.168.1.10 -i ~/.ssh/id_ed25519_macmini # context-find:os=posix
build-box -p 2222 # context-find:os=windows
prod-jump -J bastion.example.com
```

A line is an ssh target followed by any ssh options you want, passed through
unchanged, with a leading `~` in a path expanded. So a host needing a specific
key, a non-standard port or a jump box works with no `~/.ssh/config` entry.
The optional `context-find:os` suffix selects the remote Python command. Old
lines without the suffix default to macOS, Linux or Unix.

Use `context-find --onboard-external` to enter the target and key path, then
select the remote OS with the arrow keys.

Every search then covers those machines too. Local results appear immediately
and each host folds its rows in as it answers, so a sleeping machine never
delays the interface; the header names the hosts still being searched. Remote
rows are tagged with the host, and `r` resumes them over `ssh -t`.

For a one-off machine, or to ignore the file entirely:

```sh
context-find --host "mini -i ~/.ssh/other_key" "kite login"
context-find --local "kite login"
```

### Nothing to install on the far side

`context-find` pipes its own scanner to the remote Python over ssh stdin. The
remote searches its own transcripts and returns only what matched. There is no
agent, no daemon, and no package to keep in sync across machines. Upgrading the
tool on your laptop upgrades what runs everywhere.

Requirements on a remote: ssh access with key auth, plus `python3` or `python`
on macOS, Linux and Unix, or the `py` launcher on Windows. If the interpreter
lives somewhere unusual, `--onboard-external` asks for the exact command and
pins it per host in the hosts file's `python=` field:

To resume a session on Windows, the SSH account must have `powershell.exe` and
the `claude` or `codex` command on its `PATH`.

```
# ~/.context-find/hosts
build-box -i ~/.ssh/key # context-find:os=posix python=/opt/py/bin/python3
```

A host that is asleep, unreachable or misconfigured prints one warning line and
the search continues without it. One bad host never fails the run.

---

## Safety

`context-find` reads transcripts and never writes to them. It makes no copy of
your conversations anywhere: no index file, no database, no cloud sync. Remote
searches run over your existing ssh trust, and only matching results cross the
wire, inside a session ssh has already encrypted.

This is deliberate. Transcripts hold whatever you have pasted into a prompt,
which in practice means account identifiers, customer data, internal hostnames
and sometimes credentials. A synced or cached copy of that corpus is a far
larger thing to protect than the transcripts already sitting under your home
directory. So the tool does not create one.

The tradeoff is that a machine must be reachable at the moment you search it.
If yours sleeps, enabling wake on network access, or putting both machines on a
private mesh such as Tailscale, closes that gap without leaving a copy of
anything at rest.

Details worth knowing:

- Remote scanner arguments use Base64-encoded JSON, so neither POSIX nor Windows
  shells interpret their contents.
- Non-interactive ssh runs with `BatchMode=yes`, so a misconfigured host fails
  fast instead of hanging the interface on a password prompt.
- Interactive resume drops `BatchMode`, so ssh can still ask for a key
  passphrase.
- Error messages show the host label only, never the key path from your hosts
  file.

---

## How it works

Both tools write conversations as JSONL under your home directory.
`context-find` reads those files directly and never modifies them.

- **No index and no daemon.** A full scan of 122 MB across 212 Claude
  transcripts takes about 0.2 s, which is faster than keeping an index honest.
  Adding Codex did not change that materially.
- **Every store on the machine is searched.** Setting `CLAUDE_CONFIG_DIR` for
  some shells splits your history in two; `context-find` reads both it and
  `~/.claude`. On the machine this was built on, that was the difference
  between 64 and 68 results for the same query.
- **Subagent sidechains are skipped**, since they have no session of their own
  to resume.
- **Injected preambles never become a summary.** Hook output, system reminders,
  IDE notices, slash-command wrappers and Codex's AGENTS.md block are not what
  you typed, so the row shows the first thing you actually said. Press `t` in
  the reader to see the rest.
- **Sorted by last activity**, not by when the session started.
- **Progressive results.** Local rows draw in about 0.27 s even when a
  configured host is powered off and will take ten seconds to time out.

---

## The remote agent

The tool is a single TypeScript front end. Remote-machine search is the one
place Python survives: `src/context_find/store.py` is a self-contained,
standard-library-only scanner that the TypeScript build ships as an asset in
`dist/` and pipes over ssh to remote hosts. Python is chosen there because
`python3` is already on almost every machine, while Node usually is not, so a
remote needs nothing installed.

Locally, `ts/src/store.ts` does the scan and render itself rather than shelling
out to Python, so `npx context-find` never needs a Python interpreter on the
box you run it from. That leaves two copies of the parse-and-render logic — the
local `store.ts` and the remote `store.py` — which must stay identical or a
remote row would render differently from a local one.

So `ts/test/golden.test.ts` renders identical fixtures through both and diffs
them: three widths, every flag combination, for both agents, plus `header`,
`scan`, the banner and relative time formatting. (It needs `python3` on PATH to
run.)

It has already earned its place three times. It caught that Python's `textwrap`
preserves a double space inside a wrapped line where the first TypeScript
wrapper collapsed it; that one side printed UTC while the other printed local
time; and that the two conversation-count payloads had diverged in shape.

If you change parsing or rendering, change `store.ts` and `store.py` together,
and let the golden test confirm they still agree.

---

## Troubleshooting

Use `context-find --debug --list-machines` to print application mode, search
counts, machine checks, reader loads, and SSH request results. Debug output
goes to stderr.

**A host always times out.** Check `ssh <host>` works on its own first.
`context-find` adds `BatchMode=yes`, so any host that needs an interactive
password will fail; use a key.

**A remote returns "remote sent no usable output".** The selected OS is wrong,
or Python is not on that machine's login PATH. Correct the `context-find:os`
suffix, or add a `python=<path>` field, in the hosts file.

**A conversation is missing.** Check `--list-machines` first; the counts tell
you whether the store is even visible. Remember the search matches raw
transcript text, so a phrase you only *remember* saying may have been phrased
differently.

**The banner is missing.** It hides itself below 24 rows or 38 columns, to
spend those rows on results.

**Boxes render as garbage.** The console is not UTF-8. The tool falls back to
ASCII automatically when it detects that; if detection fails, the encoding is
lying about itself.

---

## Development

```sh
cd ts
npm run build                         # tsc, then copies store.py into dist/
npm test                              # typescript + cross-language parity (needs python3 on PATH)
npm run typecheck
```

Run `npm run build` to compile the TypeScript sources and copy `store.py` into
`dist/` (which `npm test` also runs to ensure the packaged agent bundle is
available for remote agent tests). The golden suite shells out to `python3` to
diff the local render against the remote agent.

```
context-find/
  src/context_find/
    store.py      remote agent: self-contained scanner shipped over ssh
  ts/src/
    store.ts      local scan and render, kept in step with store.py
    remote.ts     ssh transport, host specs, ships store.py to the far side
    search.ts     progressive local-then-remote results
    rows.ts       row formatting and scroll maths, kept out of the JSX
    ui.tsx        Ink components
    cli.tsx       arguments, list mode, machines table, resume dispatch
  ts/test/        typescript tests, including the cross-language golden suite
```

A test plan covering the manual cases, including the ones that need a real
terminal or a second machine, lives outside this repo.

---

## License

MIT
