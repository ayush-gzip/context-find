#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import {
  machineRow,
  printTerminalText,
  printTerminalError,
} from "./terminal.ts";
import { debug } from "./debug.ts";
import {
  appendHostSpec,
  remoteConversationCounts,
  HOSTS_FILE,
  buildHostSpec,
  hostDisplayName,
  lastPingedAt,
  readHosts,
  recordPing,
  type RemoteOS,
} from "./remote.ts";
import {
  relativeTime,
  conversationCounts,
  setExtraConfigDirs,
} from "./store.ts";
import { serviceCommand } from "./service.ts";
import { serveWeb } from "./web.ts";
import * as banner from "./banner.ts";

const USAGE =
  banner.text() +
  `
cfind - finds your Claude Code and Codex sessions. The dashboard is where you
search, read and talk to them.

  cfind                                    start the dashboard service
  cfind daemon [start|stop|status|install]  manage the dashboard service
  cfind ask "QUESTION"                     for agents: mark this chat as waiting for your answer

  --onboard-external  add a machine to ~/.context-find/hosts, interactively
  --list-machines     show every machine this can index, and what it holds
  --extra-dir DIR     also read this Claude config dir, e.g. ~/.claude-personal (repeatable)
  --port N            dashboard port (default 4319)
  --debug             print application diagnostics to stderr
  -h, --help          show this message
`;

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
    const os: RemoteOS = /^w/i.test(
      (await rl.question("Remote OS, macOS/Linux or Windows? [m/w]: ")).trim(),
    )
      ? "windows"
      : "posix";
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
      "extra-dir": { type: "string", multiple: true, default: [] },
      "onboard-external": { type: "boolean", default: false },
      debug: { type: "boolean", default: false },
      "list-machines": { type: "boolean", default: false },
      port: { type: "string" },
      // Ignored: LaunchAgents written by earlier versions run `service run --local`.
      // The service now always reads the hosts file, as `cfind web` did.
      local: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  // An agent runs this as its last step when it needs the user. The dashboard
  // finds the call in the transcript, so there is nothing to do here.
  if (positionals[0] === "ask") {
    printTerminalText("cfind: this chat now shows as waiting for your answer.");
    return 0;
  }

  if (values.debug) {
    process.env["CONTEXT_FIND_DEBUG"] = "1";
    // The background service writes stderr to its log, so mirror diagnostics to a
    // file too. Fresh per run, in the config dir.
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

  for (const dir of values["extra-dir"]) {
    if (!existsSync(join(dir, "projects")))
      printTerminalError(`! --extra-dir ${dir}: no projects folder, skipped`);
  }
  setExtraConfigDirs(values["extra-dir"]);

  if (values["onboard-external"]) {
    debug("selected mode: onboarding");
    return onboardExternalHost();
  }
  if (values["list-machines"]) {
    debug("selected mode: machine-list");
    return printMachineTable(readHosts());
  }

  const [command = "daemon", action] = positionals;
  if (command !== "daemon" && command !== "service") {
    printTerminalError(
      `cfind no longer searches in the terminal. Run cfind to start the dashboard, then search there.`,
    );
    return 1;
  }
  setExtraConfigDirs([
    ...values["extra-dir"],
    join(homedir(), ".claude-personal"),
  ]);
  const port = Number(values.port) || 4319;
  return serviceCommand(
    action ?? (command === "daemon" ? "start" : "status"),
    port,
    () => serveWeb(readHosts(), port, true),
  );
}

main()
  .then((code) => process.exit(code))
  .catch((error: Error) => {
    printTerminalError(error.message);
    process.exit(1);
  });
