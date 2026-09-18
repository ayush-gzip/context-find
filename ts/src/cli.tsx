#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import React from "react";
import { Box, Text, render as renderInk, useApp, useInput } from "ink";

import { App } from "./ui.tsx";
import { printTerminalText, printTerminalError } from "./terminal.ts";
import { debug } from "./debug.ts";
import { Search } from "./search.ts";
import {
  appendHostSpec,
  remoteConversationCounts,
  HOSTS_FILE,
  buildHostSpec,
  buildResumeCommand,
  hostDisplayName,
  lastPingedAt,
  quoteForPosixShell,
  readHosts,
  recordPing,
  renderRemoteTranscript,
  resumeRemote,
  type RemoteOS,
} from "./remote.ts";
import { machineRow } from "./rows.ts";
import {
  relativeTime,
  conversationCounts,
  projectsRoots,
  prettyPath,
  renderTranscript,
  sanitizeTerminalText,
  sessionId,
  SOURCES,
  type Line,
  type Session,
  type Source,
} from "./store.ts";
import { serveWeb } from "./web.ts";
import * as banner from "./banner.ts";

const USAGE =
  banner.text() +
  `
context-find - search and resume Claude Code conversations

  context-find [query] [options]
  context-find show <path> [--host SSH]   cat one session's transcript as text
  context-find web [--port N]             open a read-only browser view

  query            text to find in transcripts; omit to browse everything

  --host SSH       also search this ssh host (repeatable); for show, the host holding <path>
  --local          ignore the hosts configured in ~/.context-find/hosts
  --onboard-external  add a machine to ~/.context-find/hosts, interactively
  --debug          print application diagnostics to stderr
  --json           print search results as JSON (for scripts and agents)
  --list           print results instead of opening the browser
  --list-machines  show every machine this can index, and what it holds
  --width N        wrap width for show (default 100)
  --port N         port for web (default 4319)
  --claude         only Claude Code conversations
  --codex          only Codex conversations
  -h, --help       show this message
`;

const AGENTS: Record<string, string[]> = {
  claude: ["claude", "--resume"],
  codex: ["codex", "resume"],
};

function agentResumeArgv(source: Source): string[] {
  const argv = AGENTS[source];
  if (!argv) throw new Error(`unsupported session source: ${source}`);
  return argv;
}

function resumeSession(session: Session): number {
  const id = sessionId(session);
  const argv = agentResumeArgv(session.source);
  const location = session.host != null ? "remote" : "local";
  debug(`${location} resume started: source=${session.source}`);
  if (session.host) {
    const status = resumeRemote(session.host, session.cwd, id, argv);
    debug(
      `${location} resume finished: source=${session.source}, status=${status}`,
    );
    return status;
  }
  const done = spawnSync(argv[0]!, [...argv.slice(1), id], {
    cwd: session.cwd,
    stdio: "inherit",
  });
  if (done.error) {
    debug(
      `${location} resume failed to start: source=${session.source}, status=127`,
    );
    printTerminalText(
      `${argv[0]} not found on PATH. Run this yourself:\n` +
        `  cd ${quoteForPosixShell(session.cwd)} && ${argv.join(" ")} ${quoteForPosixShell(id)}`,
    );
    return 127;
  }
  const status = done.status ?? 0;
  debug(
    `${location} resume finished: source=${session.source}, status=${status}`,
  );
  return status;
}

async function printMachineTable(hosts: string[]): Promise<number> {
  debug(`machine list started: remote-hosts=${hosts.length}`);
  type Row = [string, Record<string, number> | null, string, string | null];
  const rows: Row[] = [["this machine", conversationCounts(), "ready", null]];
  await Promise.all(
    hosts.map(async (spec) => {
      try {
        const tally = await remoteConversationCounts(spec);
        recordPing(spec);
        rows.push([
          hostDisplayName(spec),
          tally,
          `last pinged ${relativeTime(lastPingedAt(spec))}`,
          null,
        ]);
      } catch (error) {
        const last = lastPingedAt(spec);
        const status = last
          ? `unreachable, last ok ${relativeTime(last)}`
          : "unreachable";
        rows.push([
          hostDisplayName(spec),
          null,
          status,
          (error as Error).message,
        ]);
      }
    }),
  );

  const heads = ["MACHINE", "CLAUDE", "CODEX", "TOTAL", "LAST USED", "STATUS"];
  const body: string[][] = [];
  const notes: [string, string][] = [];

  for (const [name, tally, status, error] of rows) {
    if (error) notes.push([name, error]);
    body.push(machineRow(name, tally, status));
  }

  const widths = heads.map((_, i) =>
    Math.max(...[heads, ...body].map((row) => row[i]!.length)),
  );
  const right = new Set([1, 2, 3]);

  const line = (left: string, mid: string, end: string) =>
    left + widths.map((w) => "─".repeat(w + 2)).join(mid) + end;
  const rule = (cells: string[]) =>
    "│ " +
    cells
      .map((cell, i) =>
        right.has(i) ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!),
      )
      .join(" │ ") +
    " │";

  printTerminalText("\n  machines context-find can search\n");
  printTerminalText("  " + line("╭", "┬", "╮"));
  printTerminalText("  " + rule(heads));
  printTerminalText("  " + line("├", "┼", "┤"));
  for (const cells of body) printTerminalText("  " + rule(cells));
  printTerminalText("  " + line("╰", "┴", "╯"));

  const total = body
    .filter((c) => c[3] !== "-")
    .reduce((sum, c) => sum + Number(c[3]), 0);
  const reachable = body.filter((c) => c[5] !== "unreachable").length;
  debug(
    `machine list finished: conversations=${total}, reachable=${reachable}, unreachable=${notes.length}`,
  );
  printTerminalText(
    `\n  ${total} conversations across ${reachable} machine${reachable === 1 ? "" : "s"}`,
  );
  for (const [name, error] of notes)
    printTerminalText(`  ${name} did not answer: ${error}`);
  printTerminalText();
  return notes.length ? 1 : 0;
}

function printSessionList(
  sessions: Session[],
  errors: [string, string][],
): void {
  for (const session of sessions) {
    const at = new Date(session.mtime * 1000); // local time, matching store.py
    const pad = (value: number) => String(value).padStart(2, "0");
    const when =
      `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
      `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    const label = session.host ? hostDisplayName(session.host) + ":" : "";
    printTerminalText(
      `${when}  ${session.source.padEnd(6)}  ${label}${prettyPath(session.cwd)}  [${session.branch}]`,
    );
    printTerminalText(`  ${sanitizeTerminalText(session.summary).slice(0, 120)}`);
    const id = sessionId(session);
    const argv = agentResumeArgv(session.source);
    if (session.host) {
      const isWindows = /#\s+context-find:os=windows(?:\s|$)/.test(session.host);
      const cmd = isWindows
        ? buildResumeCommand(session.host, session.cwd, id, argv)
        : `cd ${quoteForPosixShell(session.cwd)} && ${argv.join(" ")} ${quoteForPosixShell(id)}`;
      printTerminalText(
        `  ssh -t ${hostDisplayName(session.host)} ${quoteForPosixShell(cmd)}\n`,
      );
    } else {
      printTerminalText(
        `  cd ${quoteForPosixShell(session.cwd)} && ${argv.join(" ")} ${quoteForPosixShell(id)}\n`,
      );
    }
  }
  for (const [host, message] of errors) printTerminalError(`! ${host}: ${message}`);
}

function printSessionsJson(
  sessions: Session[],
  errors: [string, string][],
): void {
  printTerminalText(
    JSON.stringify(
      {
        sessions: sessions.map((s) => ({
          path: s.path,
          source: s.source,
          cwd: s.cwd,
          branch: s.branch,
          summary: s.summary,
          mtime: s.mtime,
          sid: sessionId(s),
          host: s.host || null, // full ssh spec; pass back as `show --host`
          hostLabel: s.host ? hostDisplayName(s.host) : null,
        })),
        errors: errors.map(([host, message]) => ({ host, message })),
      },
      null,
      2,
    ).replace(/[\u007f-\u009f]/g, (char) =>
      "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
    ),
  );
}

async function printSessionTranscript(
  path: string | undefined,
  host: string | undefined,
  width: number,
): Promise<number> {
  if (!path) {
    printTerminalError("usage: context-find show <path> [--host SSH]");
    return 1;
  }
  try {
    const lines: Line[] = host
      ? await renderRemoteTranscript(host, path, width, true, false)
      : renderTranscript(path, width, true, false);
    for (const [, text] of lines) printTerminalText(sanitizeTerminalText(text));
    return 0;
  } catch (error) {
    printTerminalError((error as Error).message);
    return 1;
  }
}

function printNothingFound(query: string): number {
  if (query) printTerminalText(`no conversations matching '${query}'`);
  else
    printTerminalText(
      `no conversations under ${projectsRoots().join(", ") || "no store found"}`,
    );
  return 1;
}

const REMOTE_OS_OPTIONS: { label: string; value: RemoteOS }[] = [
  { label: "macOS / Linux / Unix", value: "posix" },
  { label: "Windows", value: "windows" },
];

function RemoteOSPicker({
  onChoose,
  onCancel,
}: {
  onChoose: (os: RemoteOS) => void;
  onCancel: () => void;
}) {
  const [cursor, setCursor] = React.useState(0);
  const { exit } = useApp();
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      onCancel();
      return exit();
    }
    if (key.upArrow) return setCursor(Math.max(0, cursor - 1));
    if (key.downArrow)
      return setCursor(Math.min(REMOTE_OS_OPTIONS.length - 1, cursor + 1));
    if (key.return) {
      onChoose(REMOTE_OS_OPTIONS[cursor]!.value);
      exit();
    }
  });
  return (
    <Box flexDirection="column">
      <Text>Remote operating system:</Text>
      {REMOTE_OS_OPTIONS.map((option, index) => (
        <Text key={option.value} inverse={index === cursor}>
          {index === cursor ? "❯ " : "  "}
          {option.label}
        </Text>
      ))}
      <Text dimColor>↑↓ select Enter confirm</Text>
    </Box>
  );
}

async function chooseRemoteOS(): Promise<RemoteOS | null> {
  let chosen: RemoteOS | null = null;
  const app = renderInk(
    <RemoteOSPicker
      onChoose={(os) => (chosen = os)}
      onCancel={() => undefined}
    />,
  );
  await app.waitUntilExit();
  return chosen;
}

async function onboardExternalHost(): Promise<number> {
  debug("external onboarding started");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const target = (
      await rl.question("Machine (ssh host or user@host): ")
    ).trim();
    if (!target) {
      debug("external onboarding rejected an empty target");
      printTerminalError("need a non-empty ssh target");
      return 1;
    }
    if (readHosts().some((spec) => hostDisplayName(spec) === target)) {
      debug("external onboarding skipped an existing host");
      printTerminalText(`${target} is already in ${HOSTS_FILE}`);
      return 0;
    }
    const keyFile = (
      await rl.question("Path to its ssh key file (blank if none): ")
    ).trim();
    if (keyFile) {
      const expanded = keyFile.startsWith("~")
        ? homedir() + keyFile.slice(1)
        : keyFile;
      if (!existsSync(expanded)) {
        debug("external onboarding key file was not found");
        printTerminalError(`warning: no file at ${expanded}, adding anyway`);
      }
    }
    const python = (
      await rl.question(
        "Remote python command (blank to autodetect; e.g. py -3): ",
      )
    ).trim();
    rl.close();
    const os = await chooseRemoteOS();
    if (!os) {
      debug("external onboarding cancelled during OS selection");
      return 1;
    }
    const spec = buildHostSpec(target, keyFile, os, python);
    appendHostSpec(spec);
    debug(
      `external onboarding finished: os=${os}, python=${python ? "pinned" : "auto"}`,
    );
    printTerminalText(`added to ${HOSTS_FILE}:\n  ${spec}`);
    return 0;
  } finally {
    rl.close();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      host: { type: "string", multiple: true, default: [] },
      local: { type: "boolean", default: false },
      "onboard-external": { type: "boolean", default: false },
      debug: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      "list-machines": { type: "boolean", default: false },
      width: { type: "string" },
      port: { type: "string" },
      claude: { type: "boolean", default: false },
      codex: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.debug) {
    process.env["CONTEXT_FIND_DEBUG"] = "1";
    // Interactive mode hides stderr behind the alternate screen, so mirror the log to a
    // file. Fresh per run, in the config dir; the path is printed before the UI takes over.
    const logFile = join(
      dirname(HOSTS_FILE),
      `debug_${Math.floor(Date.now() / 1000)}.log`,
    );
    mkdirSync(dirname(logFile), { recursive: true });
    writeFileSync(logFile, "");
    process.env["CONTEXT_FIND_DEBUG_FILE"] = logFile;
    printTerminalError(`[cfind] debug log: ${logFile}`);
    debug("application diagnostics enabled");
  }

  if (values.help) {
    printTerminalText(USAGE);
    return 0;
  }

  if (values["onboard-external"]) {
    debug("selected mode: onboarding");
    return onboardExternalHost();
  }

  if (positionals[0] === "show") {
    debug("selected mode: show");
    return printSessionTranscript(
      positionals[1],
      values.host[0],
      Number(values.width) || 100,
    );
  }

  if (positionals[0] === "web") {
    debug("selected mode: web");
    const webHosts = values.local
      ? []
      : values.host.length
        ? values.host
        : readHosts();
    return serveWeb(webHosts, Number(values.port) || 4319);
  }

  const query = positionals[0] ?? "";
  const hosts = values.local
    ? []
    : values.host.length
      ? values.host
      : readHosts();
  // no flag means every agent; naming one narrows to it
  const named = SOURCES.filter((name) => values[name]);
  const wanted: readonly Source[] = named.length ? named : SOURCES;

  const interactive =
    !values.list && !values.json && process.stdout.isTTY && process.stdin.isTTY;
  const mode = values["list-machines"]
    ? "machine-list"
    : interactive
      ? "interactive"
      : "list";
  debug(
    `selected mode: ${mode}; remote-hosts=${hosts.length}; sources=${wanted.join(",")}`,
  );

  if (values["list-machines"]) return printMachineTable(hosts);

  if (!interactive) {
    // A full-screen UI needs a real terminal; pipes and CI get the plain list.
    const search = new Search(query, hosts);
    await search.wait();
    search.sessions = search.sessions.filter((s) => wanted.includes(s.source));
    if (values.json) {
      printSessionsJson(search.sessions, search.errors);
      return 0;
    }
    if (!search.sessions.length) {
      for (const [host, message] of search.errors)
        printTerminalError(`! ${host}: ${message}`);
      return printNothingFound(query);
    }
    printSessionList(search.sessions, search.errors);
    return 0;
  }

  const search = new Search(query, hosts);
  if (!search.sessions.length && !search.pending.length)
    return printNothingFound(query);

  let chosen: Session | null = null;
  process.stdout.write("\x1b[?1049h"); // alternate screen, restored below
  try {
    const app = renderInk(
      <App
        search={search}
        hosts={hosts}
        title={"context-find: " + (query || "all conversations")}
        wanted={wanted}
        onChoose={(session) => (chosen = session)}
      />,
    );
    await app.waitUntilExit();
  } finally {
    process.stdout.write("\x1b[?1049l");
  }

  return chosen ? resumeSession(chosen) : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: Error) => {
    printTerminalError(error.message);
    process.exit(1);
  });
