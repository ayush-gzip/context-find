import { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";

import { relativeTime, conversationCounts, prettyPath, renderTranscript, type Line, type Session, type Style } from "./store.ts";
import { remoteConversationCounts, hostDisplayName, lastPingedAt, recordPing, renderRemoteTranscript } from "./remote.ts";
import { clamp, COLUMN_WIDTHS, listAction, machineRow, machineLine, sessionRow, clampScrollTop,
         tableHeader, verticalMotion } from "./rows.ts";
import * as banner from "./banner.ts";
import { Search } from "./search.ts";
import { debug } from "./debug.ts";

type RemoteSession = Session & { host: string };

function isRemoteSession(session: Session): session is RemoteSession{
    return session.host != null;
}

const COLOR: Record<Style, { color?: string; dim?: boolean; bold?: boolean }> = {
  user: { color: "magenta", bold: true },
  assistant: { color: "cyan", bold: true },
  tool: { color: "green" },
  meta: { dim: true },
  text: {},
};

function useTerminalSize(): { columns: number; rows: number } {
  const [size, setSize] = useState({
    columns: process.stdout.columns || 100,
    rows: process.stdout.rows || 30,
  });
  useEffect(() => {
    const onResize = () =>
      setSize({ columns: process.stdout.columns || 100, rows: process.stdout.rows || 30 });
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);
  return size;
}

function Row({ session, selected, width }: {
  session: Session; selected: boolean; width: number;
}) {
  const cell = sessionRow(session);
  const fixed = 2 + COLUMN_WIDTHS.stamp + COLUMN_WIDTHS.source + COLUMN_WIDTHS.machine +
    COLUMN_WIDTHS.folder + COLUMN_WIDTHS.branch;
  const summary = cell.summary.slice(0, Math.max(width - fixed - 1, 10));
  if (selected) {
    const flat = cell.stamp.padEnd(COLUMN_WIDTHS.stamp) + "  " +
      cell.source.padEnd(COLUMN_WIDTHS.source) + cell.host.padEnd(COLUMN_WIDTHS.machine) +
      cell.folder.padEnd(COLUMN_WIDTHS.folder) + cell.branch.padEnd(COLUMN_WIDTHS.branch) + summary;
    return <Text inverse>{flat.slice(0, width).padEnd(width)}</Text>;
  }
  return (
    <Text wrap="truncate">
      <Text dimColor>{cell.stamp.padEnd(COLUMN_WIDTHS.stamp)}</Text>
      {"  "}
      <Text color={cell.source === "codex" ? "green" : "red"}>
        {cell.source.padEnd(COLUMN_WIDTHS.source)}
      </Text>
      <Text color="magentaBright">{cell.host.padEnd(COLUMN_WIDTHS.machine)}</Text>
      <Text color="cyan">{cell.folder.padEnd(COLUMN_WIDTHS.folder)}</Text>
      <Text color="yellow">{cell.branch.padEnd(COLUMN_WIDTHS.branch)}</Text>
      <Text>{summary}</Text>
    </Text>
  );
}

function List({ search, title, version, wanted, deepPending, deepQuery, onDeep,
               onOpen, onResume, onListMachines, onQuit }: {
  search: Search; title: string; version: number; wanted: readonly string[];
  deepPending: boolean; deepQuery: string; onDeep: (query: string) => void;
  onOpen: (session: Session) => void; onResume: (session: Session) => void;
  onListMachines: () => void; onQuit: () => void;
}) {
  const { columns, rows } = useTerminalSize();
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const [top, setTop] = useState(0);
  const [searching, setSearching] = useState(false);

  const shown = useMemo(() => {
    const needle = filter.toLowerCase();
    const inScope = search.sessions.filter((s) => wanted.includes(s.source));
    // A deep search already matched full content for this exact query; header-filtering
    // it again would hide body-only matches, which is the whole point of deep search.
    if (deepQuery && filter === deepQuery) return inScope;
    return inScope.filter((s) =>
      `${s.source} ${s.host} ${s.cwd} ${s.branch} ${s.summary}`.toLowerCase().includes(needle));
    // version changes whenever a remote host lands
  }, [filter, version, wanted, search.sessions, deepQuery]);

  const headLines = 4 + search.errors.length +
    (rows >= 24 && columns >= banner.WIDTH + 4 ? banner.lines().length + 1 : 0);
  const view = Math.max(rows - headLines - 1, 1);
  const maxIndex = Math.max(shown.length - 1, 0);
  const safeCursor = clamp(cursor, 0, maxIndex);
  const safeTop = clampScrollTop(top, safeCursor, view);

  useInput((input, key) => {
    const action = listAction(input, key, searching);
    if (action === "quit") return onQuit();
    if (action === "normal") return setSearching(false);
    if (action === "search") return setSearching(true);
    if (action === "list-machines") return onListMachines();
    if (action === "resume") {
      const picked = shown[safeCursor];
      if (picked) onResume(picked);
      return;
    }
    if (action === "view") {
      const picked = shown[safeCursor];
      if (picked) onOpen(picked);
      return;
    }
    if (action === "deep") {
      onDeep(filter);
      setCursor(0);
      setTop(0);
      return;
    }
    let next = safeCursor;
    if (action === "up") next -= 1;
    else if (action === "down") next += 1;
    else if (action === "page-up") next -= view;
    else if (action === "page-down") next += view;
    else if (action === "backspace") {
      setFilter(filter.slice(0, -1));
      setCursor(0);
      setTop(0);
      return;
    } else if (action === "type") {
      setFilter(filter + input);
      setCursor(0);
      setTop(0);
      return;
    }
    next = clamp(next, 0, maxIndex);
    setCursor(next);
    setTop(clampScrollTop(safeTop, next, view));
  });

  // the wordmark is a luxury; a short window spends those rows on results
  const showLogo = rows >= 24 && columns >= banner.WIDTH + 4;
  return (
    <Box flexDirection="column" width={columns}>
      {showLogo
        ? banner.lines().map((line, index) => (
            <Text key={index} color="magentaBright">{"  " + line}</Text>
          ))
        : null}
      {showLogo ? <Text> </Text> : null}
      <Text wrap="truncate">
        <Text dimColor> {title}  </Text>
        <Text dimColor>
          {shown.length}/{search.sessions.length}
        </Text>
        {deepQuery ? <Text color="green">  deep “{deepQuery}”</Text> : null}
        {deepPending ? (
          <Text color="magentaBright">  searching…</Text>
        ) : search.pending.length ? (
          <Text color="magentaBright">  searching {search.pending.join(", ")}…</Text>
        ) : null}
      </Text>
      <Text wrap="truncate">
        <Text color="magenta" bold> search </Text>
        <Text>{filter}{searching ? "▌" : ""}</Text>
      </Text>
      {search.errors.map(([host, message]) => (
        <Text key={host} color="red" wrap="truncate"> {host}: {message}</Text>
      ))}
      <Text dimColor wrap="truncate">
        {searching
          ? " type to filter  backspace edit  ↑↓/^j^k move  ^d deep  enter resume  tab view  esc normal"
          : " j/↓/^j down  k/↑/^k up  / search  ^d deep  enter resume  v view  l list-machines  esc exit"}
      </Text>
      <Text bold wrap="truncate">{tableHeader(columns)}</Text>
      {shown.length === 0 ? (
        <Text dimColor>  no conversations match</Text>
      ) : (
        shown.slice(safeTop, safeTop + view).map((session, index) => (
          <Row
            key={session.host + session.path}
            session={session}
            selected={safeTop + index === safeCursor}
            width={columns}
          />
        ))
      )}
    </Box>
  );
}

interface MachineRow {
  spec: string;
  name: string;
  tally: Record<string, number> | null;
  status: string;
  error?: string;
}

function Machines({ hosts, onBack }: { hosts: string[]; onBack: () => void }) {
  const { columns } = useTerminalSize();
  const [rows, setRows] = useState<MachineRow[]>(() => [
    { spec: "", name: "this machine", tally: conversationCounts(), status: "ready" },
    ...hosts.map((spec) => ({
      spec, name: hostDisplayName(spec), tally: null, status: "establishing connection",
    })),
  ]);

  useEffect(() => {
    let live = true;
    debug(`machine checks started (${hosts.length} remote)`);
    for (const spec of hosts) {
      const name = hostDisplayName(spec);
      const started = Date.now();
      debug(`machine check started: ${name}`);
      remoteConversationCounts(spec)
        .then((tally) => {
          if (!live) return;
          recordPing(spec);
          const status = `last pinged ${relativeTime(lastPingedAt(spec))}`;
          debug(`machine check completed: ${name} (duration=${Date.now() - started}ms)`);
          setRows((current) => current.map((row) =>
            row.spec === spec ? { ...row, tally, status } : row));
        })
        .catch((error: Error) => {
          if (!live) return;
          debug(`machine check failed: ${name}`);
          const last = lastPingedAt(spec);
          const status = last ? `unreachable, last ok ${relativeTime(last)}` : "unreachable";
          setRows((current) => current.map((row) => row.spec === spec
            ? { ...row, status, error: error.message }
            : row));
        });
    }
    return () => { live = false; };
  }, [hosts]);

  useInput((input, key) => {
    if (input === "q" || input === "h" || key.escape || key.leftArrow ||
        (key.ctrl && input === "c")) onBack();
  });

  return (
    <Box flexDirection="column" width={columns}>
      <Text color="magenta" bold> list-machines</Text>
      <Text dimColor> q/h/esc back</Text>
      <Text bold>{machineLine(
        ["MACHINE", "CLAUDE", "CODEX", "TOTAL", "LAST USED", "STATUS"], columns,
      )}</Text>
      {rows.map((row) => (
        <Text key={row.spec || "local"} wrap="truncate">
          {machineLine(machineRow(row.name, row.tally, row.status), columns)}
        </Text>
      ))}
      {rows.filter((row) => row.error).map((row) => (
        <Text key={row.spec + ":error"} color="red" wrap="truncate">
          {` ${row.name}: ${row.error}`}
        </Text>
      ))}
    </Box>
  );
}

function Reader({ session, onBack, onResume }: {
  session: Session; onBack: () => void; onResume: () => void;
}) {
  const { columns, rows } = useTerminalSize();
  const [showAll, setShowAll] = useState(false);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [top, setTop] = useState(0);

  useEffect(() => {
    let live = true;
    setLines(null);
    const width = columns - 2;
    const location = session.host != null ? `remote ${hostDisplayName(session.host)}` : "local";
    debug(`reader load started: ${location} (extras=${showAll}, width=${width})`);
    const load = session.host
      ? renderRemoteTranscript(session.host, session.path, width, showAll, false)
      : Promise.resolve(renderTranscript(session.path, width, showAll, false));
    load
      .then((result) => {
        if (!live) return;
        debug(`reader load completed: ${location} (${result.length} lines)`);
        setLines(result);
      })
      .catch((error: Error) => {
        if (!live) return;
        debug(`reader load failed: ${location}`);
        setLines([["meta", error.message]]);
      });
    return () => {
      live = false;
    };
  }, [session.path, session.host, showAll, columns]);

  const view = Math.max(rows - 3, 1);
  const total = lines?.length ?? 0;
  const safeTop = clamp(top, 0, Math.max(total - view, 0));

  useInput((input, key) => {
    if (input === "q" || key.escape || key.leftArrow || (key.ctrl && input === "c")) return onBack();
    if (input === "r" || key.return) return onResume();
    if (input === "t") {
      setShowAll(!showAll);
      setTop(0);
      return;
    }
    let next = safeTop;
    const motion = verticalMotion(input, key);
    if (motion) next += motion;
    else if (key.pageUp || input === "b") next -= view;
    else if (key.pageDown || input === " ") next += view;
    else return;
    setTop(clamp(next, 0, Math.max(total - view, 0)));
  });

  const where = (session.host ? hostDisplayName(session.host) + ":" : "") + prettyPath(session.cwd);
  return (
    <Box flexDirection="column" width={columns}>
      <Text wrap="truncate">
        <Text dimColor> {where}</Text>
        <Text dimColor>   {total} lines</Text>
      </Text>
      <Text dimColor wrap="truncate">
        {" "}j/↓/^j down  k/↑/^k up  t {showAll ? "hide extras" : "show extras"}  enter/r resume  q/esc back
      </Text>
      {lines === null ? (
        <Text dimColor>  loading…</Text>
      ) : (
        lines.slice(safeTop, safeTop + view).map((line, index) => (
          <Text key={safeTop + index} {...COLOR[line[0]]} dimColor={COLOR[line[0]].dim} wrap="truncate">
            {line[1] || " "}
          </Text>
        ))
      )}
    </Box>
  );
}

function ConfirmRemote({
    session,
    onConfirm,
    onCancel,
}: {
        session: RemoteSession;
        onConfirm: () => void;
        onCancel: () => void;
    }) {
    const { columns } = useTerminalSize();
    const [selected, setSelected] = useState<"yes" | "no">("yes");
    useInput((input, key) => {
        if (key.escape || input === "n" || input === "N" || (key.ctrl && input === "c")) {
            return onCancel();
        }
        if (input === "y" || input === "Y") {
            return onConfirm();
        }
        if (key.leftArrow || key.rightArrow || input === "h" || input === "l" || key.tab) {
            setSelected((prev) => (prev === "yes" ? "no" : "yes"));
            return;
        }
        if (key.return) {
            if (selected === "yes") onConfirm();
            else onCancel();
        }
    });
    
    const host = hostDisplayName(session.host);

    return (
        <Box flexDirection="column" width={columns} padding={1}>
            <Box
                flexDirection="column"
                borderStyle="round"
                borderColor="magenta"
                paddingX={2}
                paddingY={1}
            >
                <Text bold>
                    Connect to remote machine <Text color="magentaBright">{host}</Text>?
                </Text>
                <Text dimColor>Path: {prettyPath(session.cwd)}</Text>

                <Box marginTop={1} gap={2}>
                    <Text inverse={selected === "yes"} color={selected === "yes" ? "green" : undefined}>
                        [ Yes ]
                    </Text>
                    <Text inverse={selected === "no"} color={selected === "no" ? "red" : undefined}>
                        [ No ]
                    </Text>
                </Box>
                <Box marginTop={1}>
                <Text dimColor>
                    ←/→ or y/n to choose · enter to confirm · esc to cancel
                </Text>
                </Box>
            </Box>
        </Box>
    );
};

export function App({ search: initialSearch, hosts, title, wanted, onChoose }: {
    search: Search; hosts: string[]; title: string; wanted: readonly string[];
    onChoose: (session: Session) => void;
}) {
    const { exit } = useApp();
    const [session, setSession] = useState<Session | null>(null);
    const [confirmSession, setConfirmSession] = useState<RemoteSession | null>(null);
    const [showMachines, setShowMachines] = useState(false);
    const [version, setVersion] = useState(0);
    const [search, setSearch] = useState<Search>(initialSearch);
    const [deepPending, setDeepPending] = useState(false);
    const [deepQuery, setDeepQuery] = useState("");

    useEffect(() => {
        return search.subscribe(() => setVersion((v) => v + 1));
    }, [search]);

    // Ctrl+D re-runs the full-content search that `cfind <query>` does, live.
    // searchLocalTranscripts is synchronous, so defer past one paint to let "searching…" show first.
    const runDeep = (query: string) => {
        setDeepPending(true);
        setTimeout(() => {
            const next = new Search(query, hosts);
            setSearch(next);
            setDeepQuery(query);
            setVersion((v) => v + 1);
            setDeepPending(false);
        }, 0);
    };

    const requestResume = (target: Session) => {
        if (isRemoteSession(target)) {
            setConfirmSession(target);
        } else {
            onChoose(target);
            exit();
        }
    };

    if (showMachines) return <Machines hosts={hosts} onBack={() => setShowMachines(false)} />;

    if (confirmSession) {
        return (
            <ConfirmRemote
                session={confirmSession}
                onConfirm={() => {
                    onChoose(confirmSession);
                    exit();
                }}
                onCancel={() => setConfirmSession(null)}
            />
        );
    }

    if (session) {
        return (
            <Reader
                session={session}
                onBack={() => setSession(null)}
                onResume={() => requestResume(session)}
            />
        );
    }

    return (
        <List
            search={search}
            title={title}
            version={version}
            wanted={wanted}
            deepPending={deepPending}
            deepQuery={deepQuery}
            onDeep={runDeep}
            onOpen={setSession}
            onResume={requestResume}
            onListMachines={() => setShowMachines(true)}
            onQuit={exit}
        />
    );
}
