"""Transcript discovery, scanning and rendering.

This module is deliberately self-contained and stdlib-only: context-find pipes the
file itself over ssh stdin to search remote machines, so nothing has to be
installed on the other end.
"""
from __future__ import annotations

import base64
import json
import os
import re
import sys
import textwrap
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

# Preambles Claude Code injects into the user turn. They are never what the
# human actually typed, so they make useless summaries.
SKIP_PREFIXES = (
    "<local-command-caveat>", "<local-command-stdout>", "<command-name>",
    "<command-message>", "<command-args>", "<system-reminder>",
    "<ide_opened_file>", "<ide_selection>", "Caveat: The messages below",
)

# Codex injects its own wrappers into the user turn.
CODEX_SKIP_PREFIXES = (
    "# AGENTS.md instructions", "<environment_context>", "<user_instructions>",
    "<INSTRUCTIONS>", "<recommended_plugins>",
)

SOURCES = ("claude", "codex")

# Scanning is cheap and reads both agents in one pass; --claude / --codex
# filter the finished list rather than threading a mode through every layer.

ARG_KEYS = ("command", "file_path", "pattern", "path", "query", "url",
            "description", "prompt", "skill")

# Terminal control command / ANSI escape sanitizer (e.g. OSC 52, CSI, control codes)
ANSI_ESCAPE_RE = re.compile(
    r"\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)?|[P^_][^\x07\x1b]*(?:\x07|\x1b\\)?|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])"
    r"|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]"
)


def sanitize_terminal_text(text):
    if not text:
        return ""
    return ANSI_ESCAPE_RE.sub("", str(text))


def projects_roots():
    """Every transcript store on this machine, CLAUDE_CONFIG_DIR first.

    A machine can hold more than one: setting CLAUDE_CONFIG_DIR for some
    shells leaves earlier conversations behind in ~/.claude.
    """
    roots = []
    base = os.environ.get("CLAUDE_CONFIG_DIR")
    for candidate in ([Path(base)] if base else []) + [Path.home() / ".claude"]:
        root = candidate / "projects"
        if root.is_dir() and root not in roots:
            roots.append(root)
    return roots


def codex_roots():
    """Codex rollout store. CODEX_HOME wins, as the Codex CLI itself does."""
    base = os.environ.get("CODEX_HOME")
    root = (Path(base) if base else Path.home() / ".codex") / "sessions"
    return [root] if root.is_dir() else []


@dataclass
class Session:
    path: str
    cwd: str
    branch: str
    summary: str
    mtime: float
    host: str | None = None
    source: str = "claude"
    sid: str = ""

    @property
    def session_id(self) -> str:
        # Codex file names are rollout-<timestamp>-<uuid>, so the id comes from
        # session_meta instead of the stem.
        return self.sid or Path(self.path).stem


# --- discovery -------------------------------------------------------------

def _real_conversation(p):
    # subagent sidechains have no session of their own to resume; claude-mem's
    # observer sessions are bot chatter under ~/.claude-mem, not real conversations
    return "subagents" not in p.parts and "claude-mem-observer-sessions" not in str(p)


def transcripts(root=None):
    if root:
        return [(p, "claude") for p in Path(root).rglob("*.jsonl")
                if _real_conversation(p)]
    found = []
    for base in projects_roots():
        found += [(p, "claude") for p in base.rglob("*.jsonl")
                  if _real_conversation(p)]
    for base in codex_roots():
        found += [(p, "codex") for p in base.rglob("rollout-*.jsonl")]
    return found


def detect_source(path):
    """Codex rollouts open with a session_meta line; Claude transcripts do not."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return "codex" if '"session_meta"' in handle.readline() else "claude"
    except OSError:
        return "claude"


def _codex_text(payload):
    return "\n".join(block.get("text") or "" for block in payload.get("content") or []
                     if isinstance(block, dict) and block.get("type") in
                     ("input_text", "output_text", "text"))


def header(path, source=None):
    """(cwd, branch, summary, session_id) from the first real user turn, or None."""
    source = source or detect_source(path)
    if source == "codex":
        return _codex_header(path)
    cwd = branch = None
    for entry in entries(path):
        if entry.get("type") != "user" or not entry.get("cwd"):
            continue
        cwd, branch = entry["cwd"], entry.get("gitBranch") or "-"
        body = plain_text(entry.get("message", {}).get("content")).strip()
        if body and not body.startswith(SKIP_PREFIXES):
            return cwd, branch, sanitize_terminal_text(" ".join(body.split())), Path(path).stem
    return (cwd, branch, "(no prompt text)", Path(path).stem) if cwd else None


def _codex_header(path):
    cwd, sid = None, ""
    for entry in entries(path):
        kind = entry.get("type")
        payload = entry.get("payload") or {}
        if kind == "session_meta":
            cwd = payload.get("cwd")
            sid = payload.get("session_id") or payload.get("id") or ""
            continue
        if kind == "response_item" and payload.get("type") == "message" \
                and payload.get("role") == "user":
            body = _codex_text(payload).strip()
            if body and not body.startswith(CODEX_SKIP_PREFIXES):
                return cwd, "-", sanitize_terminal_text(" ".join(body.split())), sid
    return (cwd, "-", "(no prompt text)", sid) if cwd else None


_REMINDER_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.DOTALL)


def _search_text(path, source):
    """Lowercased bytes of the real conversation only - what the human typed and
    what the agent replied. Tool output, reasoning, and injected blocks (skill
    catalogs, system reminders, session boilerplate) are excluded, so a search
    finds sessions that actually discuss a term, not ones that merely carry the
    skill blurb that mentions it."""
    parts = []
    if source == "codex":
        for entry in entries(path):
            p = entry.get("payload") or {}
            if entry.get("type") != "response_item" or p.get("type") != "message":
                continue
            role = p.get("role")
            if role not in ("user", "assistant"):
                continue
            t = _codex_text(p).strip()
            if t and not (role == "user" and t.startswith(CODEX_SKIP_PREFIXES)):
                parts.append(t)
    else:
        for entry in entries(path):
            role = entry.get("type")
            if role not in ("user", "assistant"):
                continue
            t = plain_text(entry.get("message", {}).get("content")).strip()
            if not t:
                continue
            if role == "user":
                t = _REMINDER_RE.sub(" ", t).strip()
                if not t or t.startswith(SKIP_PREFIXES):
                    continue
            parts.append(t)
    return "\n".join(parts).lower().encode("utf-8", "replace")


def search_local_transcripts(query="", root=None):
    """Sessions whose transcript contains query, newest activity first."""
    needle = query.lower().encode("utf-8", "replace")
    found = []
    for path, source in transcripts(root):
        try:
            if needle and needle not in _search_text(path, source):
                continue
            head = header(path, source)
        except Exception:
            continue
        if head:
            try:
                mtime = path.stat().st_mtime
            except OSError:
                continue
            found.append(Session(str(path), head[0], head[1], head[2],
                                 mtime, source=source, sid=head[3]))
    found.sort(key=lambda s: s.mtime, reverse=True)
    return found


def conversation_counts():
    tally = {"claude": 0, "codex": 0, "last": 0.0}
    for path, source in transcripts():
        tally[source] = tally.get(source, 0) + 1
        try:
            tally["last"] = max(tally["last"], path.stat().st_mtime)
        except OSError:
            pass
    return tally


def relative_time(stamp, now=None):
    if not stamp:
        return "never"
    gap = max((now or time.time()) - stamp, 0)
    for limit, size, unit in ((90, 1, "second"), (5400, 60, "minute"),
                              (172800, 3600, "hour"), (1209600, 86400, "day"),
                              (7776000, 604800, "week")):
        if gap < limit:
            count = max(int(gap / size), 1)
            return "%d %s%s ago" % (count, unit, "" if count == 1 else "s")
    count = max(int(gap / 2592000), 1)
    return "%d month%s ago" % (count, "" if count == 1 else "s")


# --- rendering -------------------------------------------------------------

def entries(path):
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                item = json.loads(line)
                if isinstance(item, dict):
                    yield item
            except (ValueError, TypeError):
                continue


def plain_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text") or "" for b in content
                         if isinstance(b, dict) and b.get("type") == "text")
    return ""


def tool_arg(payload):
    if not isinstance(payload, dict):
        return ""
    for key in ARG_KEYS:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return " ".join(value.split())
    return ""


def time_of_day(stamp):
    if not isinstance(stamp, str) or len(stamp) < 16:
        return ""
    try:
        moment = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)
        return moment.astimezone().strftime("%H:%M")
    except ValueError:
        return stamp[11:16]


def render_transcript(path, width=100, show_all=False, ascii_only=False, source=None):
    """Transcript as [(style, text)] lines. Styles: user assistant tool meta."""
    if (source or detect_source(path)) == "codex":
        return _render_codex(path, width, show_all, ascii_only)
    bar, gear, arrow = ("-", "*", "->") if ascii_only else ("─", "⚙", "⤷")
    width = max(int(width), 30)
    out = []

    def speaker(label, stamp, style):
        tail = ("  " + stamp) if stamp else ""
        fill = max(width - len(label) - len(tail) - 5, 3)
        if out:
            out.append(("meta", ""))
        out.append((style, bar * 2 + " " + label + " " + bar * fill + tail))

    def body(text, style="text"):
        for para in sanitize_terminal_text(text).splitlines():
            if not para.strip():
                out.append((style, ""))
                continue
            for line in textwrap.wrap(para, width - 4) or [""]:
                out.append((style, "   " + line))

    for entry in entries(path):
        kind, stamp = entry.get("type"), time_of_day(entry.get("timestamp"))
        message = entry.get("message")
        message = message if isinstance(message, dict) else {}
        content = message.get("content")

        if kind == "user":
            results = [b for b in content if isinstance(b, dict)
                       and b.get("type") == "tool_result"] if isinstance(content, list) else []
            text = plain_text(content).strip()
            if results and not text:
                if show_all:
                    for block in results:
                        size = len(str(block.get("content") or ""))
                        out.append(("meta", "   %s result, %d chars" % (arrow, size)))
                continue
            if not text or (text.startswith(SKIP_PREFIXES) and not show_all):
                continue
            speaker("You", stamp, "user")
            body(text)

        elif kind == "assistant":
            for block in content or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and (block.get("text") or "").strip():
                    speaker("Claude", stamp, "assistant")
                    body(block["text"].strip())
                elif block.get("type") == "tool_use":
                    tool_name = sanitize_terminal_text(block.get("name") or "?")
                    tool_input = sanitize_terminal_text(tool_arg(block.get("input")))
                    line = "   %s %s  %s" % (gear, tool_name, tool_input)
                    out.append(("tool", line[:width - 1]))

        elif show_all:
            out.append(("meta", "   · " + str(kind)))

    return out or [("meta", "(nothing to show)")]


def _render_codex(path, width, show_all, ascii_only):
    """Codex rollouts: response_item envelopes rather than Claude's flat turns."""
    bar, gear = ("-", "*") if ascii_only else ("─", "⚙")
    width = max(int(width), 30)
    out = []

    def speaker(label, stamp, style):
        tail = ("  " + stamp) if stamp else ""
        fill = max(width - len(label) - len(tail) - 5, 3)
        if out:
            out.append(("meta", ""))
        out.append((style, bar * 2 + " " + label + " " + bar * fill + tail))

    def body(text):
        for para in sanitize_terminal_text(text).splitlines():
            if not para.strip():
                out.append(("text", ""))
                continue
            for line in textwrap.wrap(para, width - 4) or [""]:
                out.append(("text", "   " + line))

    for entry in entries(path):
        kind = entry.get("type")
        payload = entry.get("payload") or {}
        stamp = time_of_day(entry.get("timestamp"))

        if kind == "response_item" and payload.get("type") == "message":
            role = payload.get("role")
            text = _codex_text(payload).strip()
            if not text:
                continue
            if role == "user":
                if text.startswith(CODEX_SKIP_PREFIXES) and not show_all:
                    continue
                speaker("You", stamp, "user")
                body(text)
            elif role == "assistant":
                speaker("Codex", stamp, "assistant")
                body(text)
            elif show_all:
                speaker(str(role), stamp, "meta")
                body(text)

        elif kind == "response_item" and payload.get("type") in (
                "function_call", "custom_tool_call", "local_shell_call"):
            args = payload.get("arguments") or payload.get("input") or ""
            tool_name = sanitize_terminal_text(payload.get("name") or "?")
            tool_args = sanitize_terminal_text(" ".join(str(args).split()))
            out.append(("tool", ("   %s %s  %s" % (gear, tool_name,
                                                   tool_args))[:width - 1]))

        elif show_all and kind == "response_item":
            out.append(("meta", "   · " + str(payload.get("type"))))

    return out or [("meta", "(nothing to show)")]


def _within_roots(path):
    """True if path resolves inside a configured transcript store.

    Guards the --render entry point: the path arrives from the controlling
    machine, so it must not escape the transcript directories - symlinks and
    ../ included. Mirror of isPathContained + realpath in web.ts.
    """
    try:
        target = Path(path).resolve()
    except OSError:
        return False
    for root in projects_roots() + codex_roots():
        try:
            root_real = root.resolve()
        except OSError:
            continue
        if target == root_real or root_real in target.parents:
            return True
    return False


def _remote_main(argv):
    """Entry point used when this file is piped to a remote interpreter."""
    if argv and argv[0] == "--args-base64":
        payload = argv[1] + "=" * (-len(argv[1]) % 4)
        argv = json.loads(base64.urlsafe_b64decode(payload).decode("utf-8"))
    if argv[0] == "--scan":
        rows = []
        for session in search_local_transcripts(argv[1] if len(argv) > 1 else ""):
            row = asdict(session)
            row.pop("host", None)
            rows.append(row)
        json.dump(rows, sys.stdout)
    elif argv[0] == "--render":
        if not _within_roots(argv[1]):
            raise SystemExit("path outside transcript stores")
        json.dump(render_transcript(argv[1], int(argv[2]), argv[3] == "1", argv[4] == "1"),
                  sys.stdout)
    elif argv[0] == "--conversation-counts":
        json.dump(conversation_counts(), sys.stdout)
    else:
        raise SystemExit("unknown mode " + argv[0])


if __name__ == "__main__":
    _remote_main(sys.argv[1:])
