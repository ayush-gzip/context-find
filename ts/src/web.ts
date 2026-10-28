/** Local agent dashboard. Bind loopback only; authenticate every API request. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { platform } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { debug } from "./debug.ts";
import {
  remoteConversationCounts,
  hostDisplayName,
  lastPingedAt,
  recordPing,
  renderRemoteTranscript,
} from "./remote.ts";
import {
  relativeTime,
  codexRoots,
  conversationCounts,
  projectsRoots,
  prettyPath,
  renderTranscript,
  sessionId,
  type Line,
  type Session,
} from "./store.ts";
import { Search } from "./search.ts";
import { join } from "node:path";
import { Monitor, dashboardProfiles, monitorDir } from "./monitor.ts";
import { AgentWorkspace } from "./agents.ts";
import { ChatFeeds } from "./chatfeed.ts";
import { Deltas } from "./delta.ts";
import {
  capturePane,
  codexHolder,
  queueCodex,
  sendKey,
  sendToPane,
  takeOver,
} from "./live.ts";
import { Devices, tailscaleHost } from "./devices.ts";
import {
  MAX_UPLOAD,
  pruneUploads,
  saveUpload,
  uploadIds,
  uploadPath,
  uploadStats,
  uploadType,
  withPaths,
} from "./uploads.ts";
import { serviceState } from "./service.ts";

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(text);
}

/** Best-effort open in the default browser; the URL is always printed too. */
export function openBrowser(url: string): void {
  const cmd =
    platform() === "darwin"
      ? "open"
      : platform() === "win32"
        ? "cmd"
        : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* no opener; the printed URL still works */
  }
}

export function isPermittedHost(
  hostHeader: string | undefined,
  permittedPort: number,
): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  const allowed = new Set([
    `127.0.0.1:${permittedPort}`,
    `localhost:${permittedPort}`,
    `[::1]:${permittedPort}`,
  ]);
  if (permittedPort === 80) {
    allowed.add("127.0.0.1");
    allowed.add("localhost");
    allowed.add("[::1]");
  }
  return allowed.has(host);
}

export function resolveConfiguredHost(
  requested: string,
  configuredHosts: string[],
): string | undefined {
  const exact = configuredHosts.find((h) => h === requested);
  if (exact) return exact;
  const byDisplayName = configuredHosts.filter(
    (h) => hostDisplayName(h) === requested,
  );
  if (byDisplayName.length === 1) return byDisplayName[0];
  return undefined;
}

function safeRealPath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

export function isPathContained(
  targetPath: string,
  parentDir: string,
): boolean {
  const rel = relative(parentDir, targetPath);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export function createWebServer(
  hosts: string[],
  port = 0,
  token = randomBytes(16).toString("hex"),
) {
  const profiles = dashboardProfiles();
  const monitor = new Monitor({ roots: profiles });
  const workspace = new AgentWorkspace(profiles);
  const devices = new Devices();
  // A phone may retry a send after a dropped connection; one clientId runs once.
  const sent = new Map<string, { at: number; value?: unknown }>();
  const readJson = async (req: IncomingMessage, max: number) => {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > max) throw new Error("Request too large");
    }
    return JSON.parse(body || "{}");
  };
  let monitorStarted = false;
  const startMonitor = () => {
    if (!monitorStarted) {
      monitorStarted = true;
      monitor.start();
    }
  };
  // Streams that asked for deltas (?delta=1) get the full snapshot once, then only
  // what changed. Older apps keep getting full snapshots.
  const peers = new Set<ServerResponse>(),
    deltaPeers = new Set<ServerResponse>(),
    chatPeers = new Set<ServerResponse>();
  const write = (peer: ServerResponse, frame: string) => {
    // A peer that cannot keep up is closed; it reconnects and starts from a snapshot.
    if (peer.writableLength > 2 * 1024 * 1024) {
      peer.end();
      peers.delete(peer);
      deltaPeers.delete(peer);
    } else peer.write(frame);
  };
  const sse = (event: string, value: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
  const streams = {
    metrics: { deltas: new Deltas(), read: () => monitor.snapshot() },
    workspace: { deltas: new Deltas(), read: () => workspace.snapshot() },
  };
  /** Sends what changed to every stream; returns the snapshot it compared. */
  const flush = (name: keyof typeof streams) => {
    const s = streams[name],
      snap = s.read(),
      delta = s.deltas.next(snap);
    if (delta) {
      const frame = sse(name + "-delta", delta);
      for (const peer of deltaPeers) write(peer, frame);
    }
    if (peers.size) {
      const frame = sse(name, snap);
      for (const peer of peers) write(peer, frame);
    }
    return snap;
  };
  monitor.subscribe(() => flush("metrics"));
  // Agents change on every streamed token; one frame per 16 ms is enough.
  let workspaceQueued: ReturnType<typeof setTimeout> | undefined;
  workspace.subscribe(() => {
    workspaceQueued ??= setTimeout(() => {
      workspaceQueued = undefined;
      flush("workspace");
    }, 16);
  });
  const chats = new ChatFeeds();
  const heartbeat = setInterval(() => {
    for (const peer of [...peers, ...deltaPeers, ...chatPeers])
      peer.write(": heartbeat\n\n");
  }, 15000);
  heartbeat.unref();
  // Old attached images go even when nothing new is attached.
  pruneUploads();
  const prune = setInterval(() => pruneUploads(), 24 * 3600 * 1000);
  prune.unref();
  const localRoots = [...profiles.map((p) => p.path)].map((r) => resolve(r));
  /** Canonical transcript path, or the refusal for a path outside the stores. */
  const containedTranscript = (path: string): string | [number, string] => {
    const realTarget = safeRealPath(resolve(path));
    if (!realTarget) return [404, "path not found"];
    const realRoots = localRoots
      .map(safeRealPath)
      .filter((r): r is string => r !== null);
    return realRoots.some((r) => isPathContained(realTarget, r))
      ? realTarget
      : [403, "path outside transcript stores"];
  };

  const asRow = (s: Session) => ({
    path: s.path,
    source: s.source,
    cwd: s.cwd,
    branch: s.branch,
    summary: s.summary,
    mtime: s.mtime,
    sid: sessionId(s),
    host: s.host ? hostDisplayName(s.host) : null,
    hostLabel: s.host != null ? hostDisplayName(s.host) : null,
    pretty: prettyPath(s.cwd),
  });

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const addr = server.address();
      const currentPort = addr && typeof addr === "object" ? addr.port : port;
      if (
        !isPermittedHost(req.headers.host, currentPort) &&
        !(devices.host() && req.headers.host?.toLowerCase() === devices.host())
      ) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("forbidden: invalid host header");
        return;
      }

      const url = new URL(req.url ?? "/", `http://127.0.0.1:${currentPort}`);

      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");
      if (
        url.pathname === "/dashboard.css" ||
        url.pathname === "/dashboard.js" ||
        url.pathname === "/markdown.js" ||
        url.pathname === "/delta.js"
      ) {
        res.writeHead(200, {
          "content-type": url.pathname.endsWith(".css")
            ? "text/css"
            : "text/javascript",
        });
        res.end(
          readFileSync(
            new URL("./dashboard/" + url.pathname.slice(1), import.meta.url),
          ),
        );
        return;
      }
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          readFileSync(
            new URL("./dashboard/index.html", import.meta.url),
            "utf8",
          ).replace("__TOKEN__", token),
        );
        return;
      }

      const bearer = /^Bearer ([0-9a-f]{64})$/.exec(
          req.headers.authorization ?? "",
        )?.[1],
        device = bearer ? devices.check(bearer) : undefined;
      if (url.pathname === "/api/pair") {
        try {
          if (req.method !== "POST") throw new Error("POST required");
          const data = await readJson(req, 4096);
          if (data.action === "unpair") {
            if (!device) throw new Error("Not paired");
            devices.revoke(device.id);
            json(res, 200, { ok: true });
          } else if (devices.limited())
            json(res, 429, { error: "Too many tries. Wait a minute" });
          else json(res, 200, devices.pair(data.code, data.name));
        } catch (error) {
          json(res, 403, { error: (error as Error).message });
        }
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        // localhost + unguessable token: another origin cannot read the token, so
        // it cannot reach this corpus even though the port is open on the machine.
        // A paired phone sends its own token instead.
        const mac = url.searchParams.get("t") === token;
        if (!mac && !device) {
          json(res, 403, { error: "forbidden" });
          return;
        }
        // Pairing and sign-in stay on the Mac.
        if (
          !mac &&
          (url.pathname === "/api/devices" || url.pathname === "/api/login")
        ) {
          json(res, 403, { error: "Only from the Mac" });
          return;
        }
        const origin = req.headers.origin;
        if (
          origin &&
          origin !== `http://127.0.0.1:${currentPort}` &&
          origin !== `http://localhost:${currentPort}`
        ) {
          json(res, 403, { error: "forbidden origin" });
          return;
        }
        let clientId = "";
        try {
          if (url.pathname === "/api/devices") {
            if (req.method === "POST") {
              const data = await readJson(req, 4096);
              if (data.action === "pair-start") {
                const host = tailscaleHost();
                if (host) devices.setHost(host);
                json(res, 200, {
                  ...devices.startPairing(),
                  url: host ? `https://${host}` : null,
                });
              } else if (data.action === "revoke") {
                devices.revoke(data.id);
                json(res, 200, { ok: true });
              } else throw new Error("Unknown devices action");
            } else
              json(res, 200, { devices: devices.list(), host: devices.host() });
            return;
          }
          if (url.pathname === "/api/events") {
            startMonitor();
            res.writeHead(200, {
              "content-type": "text/event-stream",
              connection: "keep-alive",
              "x-accel-buffering": "no",
            });
            const deltas = url.searchParams.get("delta") === "1";
            // Flushing first makes this snapshot the base of the next delta.
            res.write(
              sse("metrics", deltas ? flush("metrics") : monitor.snapshot()),
            );
            res.write(
              sse(
                "workspace",
                deltas ? flush("workspace") : workspace.snapshot(),
              ),
            );
            const set = deltas ? deltaPeers : peers;
            set.add(res);
            req.on("close", () => set.delete(res));
            return;
          }
          if (url.pathname === "/api/chat-events") {
            const target = containedTranscript(
              url.searchParams.get("path") ?? "",
            );
            if (Array.isArray(target)) {
              json(res, target[0], { error: target[1] });
              return;
            }
            res.writeHead(200, {
              "content-type": "text/event-stream",
              connection: "keep-alive",
              "x-accel-buffering": "no",
            });
            try {
              const stop = chats.subscribe(target, (event, view) => {
                if (res.writableEnded) return;
                if (res.writableLength > 2 * 1024 * 1024) res.end();
                else res.write(sse(event, view));
              });
              chatPeers.add(res);
              req.on("close", () => {
                stop();
                chatPeers.delete(res);
              });
            } catch (e) {
              res.end(sse("error", { error: (e as Error).message }));
            }
            return;
          }
          if (url.pathname === "/api/metrics") {
            startMonitor();
            await monitor.refresh();
            json(res, 200, monitor.snapshot());
            return;
          }
          if (url.pathname === "/api/workspace") {
            json(res, 200, workspace.snapshot());
            return;
          }
          if (url.pathname === "/api/commands") {
            startMonitor();
            const profile = url.searchParams.get("profile") ?? "",
              cwd = url.searchParams.get("cwd") ?? "",
              seen = (x: { profile: string; cwd: string }) =>
                x.profile === profile && x.cwd === cwd;
            // Claude starts in this folder to list its commands, so only
            // folders where this profile already ran.
            if (
              !workspace.snapshot().agents.some(seen) &&
              !monitor.snapshot().sessions.some(seen)
            ) {
              json(res, 403, { error: "Unknown folder" });
              return;
            }
            json(res, 200, {
              commands: await workspace.commands(profile, cwd),
            });
            return;
          }
          if (url.pathname === "/api/live-screen") {
            startMonitor();
            const live = monitor.live(
              url.searchParams.get("profile") ?? "",
              url.searchParams.get("sid") ?? "",
            );
            if (!live) {
              json(res, 404, { error: "This session is not open in a terminal" });
              return;
            }
            json(res, 200, { screen: capturePane(live) });
            return;
          }
          if (url.pathname === "/api/accounts") {
            json(res, 200, { accounts: await workspace.accounts() });
            return;
          }
          if (url.pathname === "/api/upload") {
            if (req.method === "POST") {
              if (!(req.headers["content-type"] ?? "").startsWith("image/")) {
                json(res, 415, { error: "Image required" });
                return;
              }
              const parts: Buffer[] = [];
              let size = 0;
              for await (const chunk of req) {
                size += (chunk as Buffer).length;
                if (size > MAX_UPLOAD) {
                  json(res, 413, { error: "Images must be 10 MB or smaller" });
                  return;
                }
                parts.push(chunk as Buffer);
              }
              const id = saveUpload(Buffer.concat(parts));
              if (id) json(res, 200, { id });
              else
                json(res, 415, {
                  error: "Only PNG, JPEG, GIF and WebP images are supported",
                });
              return;
            }
            let path: string;
            try {
              path = uploadPath(url.searchParams.get("id"));
            } catch (e) {
              const bad = (e as Error).message === "Bad image id";
              json(res, bad ? 400 : 404, { error: (e as Error).message });
              return;
            }
            res.writeHead(200, {
              "content-type": uploadType(basename(path)),
              "x-content-type-options": "nosniff",
              "cache-control": "private, max-age=86400",
            });
            createReadStream(path).pipe(res);
            return;
          }
          if (url.pathname === "/api/uploads") {
            if (req.method === "POST") {
              const data = await readJson(req, 1024);
              if (data.action !== "clear") {
                json(res, 400, { error: "Unknown action" });
                return;
              }
              // Messages still waiting to be sent keep their images.
              const keep = new Set(
                workspace
                  .snapshot()
                  .agents.flatMap((a) =>
                    a.queue.flatMap((q) => q.images ?? []),
                  ),
              );
              json(res, 200, { removed: pruneUploads(true, keep) });
              return;
            }
            json(res, 200, uploadStats());
            return;
          }
          if (url.pathname === "/api/agent" || url.pathname === "/api/login") {
            if (
              req.method !== "POST" ||
              !(req.headers["content-type"] ?? "").startsWith(
                "application/json",
              )
            ) {
              json(res, 405, { error: "POST JSON required" });
              return;
            }
            let body = "";
            for await (const chunk of req) {
              body += chunk;
              if (Buffer.byteLength(body) > 128 * 1024) {
                json(res, 413, { error: "Request too large" });
                return;
              }
            }
            const data = JSON.parse(body);
            if (url.pathname === "/api/login") {
              if (typeof data.profile !== "string")
                throw new Error("Profile required");
              if (data.action === "input") {
                workspace.loginInput(data.profile, String(data.input ?? ""));
                json(res, 200, { ok: true });
              } else json(res, 200, await workspace.login(data.profile));
              return;
            }
            clientId =
              typeof data.clientId === "string"
                ? data.clientId.slice(0, 100)
                : "";
            if (clientId) {
              const prior = sent.get(clientId);
              if (prior) {
                if (prior.value === undefined)
                  json(res, 409, { error: "Still sending" });
                else json(res, 200, prior.value);
                return;
              }
              for (const [k, v] of sent)
                if (Date.now() - v.at > 10 * 60 * 1000) sent.delete(k);
              sent.set(clientId, { at: Date.now() });
            }
            const ok = (value: unknown) => {
              if (clientId) sent.set(clientId, { at: Date.now(), value });
              json(res, 200, value);
            };
            const images = uploadIds(data.images);
            const said = (v: unknown) =>
              typeof v === "string" && (!!v.trim() || images.length > 0);
            if (data.action === "create") {
              if (!said(data.prompt) || typeof data.cwd !== "string")
                throw new Error("Project folder and prompt required");
              // An external live process cannot be safely attached by resuming it a second time.
              const session = data.sid
                ? monitor
                    .snapshot()
                    .sessions.find(
                      (s) => s.id === data.sid && s.profile === data.profile,
                    )
                : undefined;
              // Codex: whoever has the session file open owns it, whatever the state says.
              const holder =
                data.sid && session?.source === "codex"
                  ? codexHolder(session.path)
                  : undefined;
              if (holder === "helper") {
                queueCodex(session!.id, withPaths(data.prompt, images));
                ok({
                  queued: true,
                  busy: ["running", "waiting"].includes(session!.state),
                });
                return;
              }
              if (holder === "other")
                throw new Error(
                  "Open in a Codex window that does not use the background helper. Reply there.",
                );
              if (
                data.sid &&
                !holder &&
                (!session ||
                  session.open ||
                  ["running", "waiting", "stale"].includes(session.state))
              )
                throw new Error("Resume requires an inactive local session");
              ok(
                await workspace.create(
                  data.profile,
                  data.cwd,
                  data.prompt,
                  data.sid,
                  session?.path,
                  images,
                ),
              );
              return;
            }
            if (
              data.action === "live-send" ||
              data.action === "live-key" ||
              data.action === "takeover"
            ) {
              const live = monitor.live(String(data.profile), String(data.sid));
              if (!live)
                throw new Error("This session is not open in a terminal");
              if (data.action === "takeover") await takeOver(live);
              else if (data.action === "live-key")
                sendKey(live, String(data.key));
              else if (!said(data.prompt)) throw new Error("Prompt required");
              else
                await sendToPane(live, withPaths(data.prompt, images), () =>
                  monitor.live(String(data.profile), String(data.sid)),
                );
              ok({ ok: true });
              return;
            }
            if (typeof data.id !== "string")
              throw new Error("Agent id required");
            if (data.action === "send") {
              if (!said(data.prompt)) throw new Error("Prompt required");
              ok(await workspace.send(data.id, data.prompt, images));
              return;
            }
            if (data.action === "cancel") {
              await workspace.cancel(data.id);
              ok({ ok: true });
              return;
            }
            if (data.action === "unqueue") {
              ok(workspace.unqueue(data.id, Number(data.index)));
              return;
            }
            if (data.action === "dismiss") {
              workspace.dismiss(data.id);
              ok({ ok: true });
              return;
            }
            if (data.action === "respond") {
              await workspace.respond(data.id, data.answer ?? {});
              ok({ ok: true });
              return;
            }
            throw new Error("Unknown agent action");
          }
          if (url.pathname === "/api/search") {
            const q = url.searchParams.get("q") ?? "";
            const search = new Search(q, hosts);
            await search.wait();
            json(res, 200, {
              sessions: search.sessions.map(asRow),
              errors: search.errors.map(([host, message]) => ({
                host,
                message,
              })),
            });
            return;
          }
          if (url.pathname === "/api/machines") {
            const row = (
              name: string,
              tally: Record<string, number> | null,
              status: string,
              error: string | null,
            ) => ({
              name,
              claude: tally ? (tally["claude"] ?? 0) : null,
              codex: tally ? (tally["codex"] ?? 0) : null,
              total: tally
                ? (tally["claude"] ?? 0) + (tally["codex"] ?? 0)
                : null,
              last: tally ? relativeTime(tally["last"]) : null,
              status,
              error,
            });
            const machines = [
              row("this machine", conversationCounts(), "ready", null),
            ];
            await Promise.all(
              hosts.map(async (spec) => {
                try {
                  const tally = await remoteConversationCounts(spec);
                  recordPing(spec);
                  machines.push(
                    row(
                      hostDisplayName(spec),
                      tally,
                      `last pinged ${relativeTime(lastPingedAt(spec))}`,
                      null,
                    ),
                  );
                } catch (error) {
                  const last = lastPingedAt(spec);
                  machines.push(
                    row(
                      hostDisplayName(spec),
                      null,
                      last
                        ? `unreachable, last ok ${relativeTime(last)}`
                        : "unreachable",
                      (error as Error).message,
                    ),
                  );
                }
              }),
            );
            json(res, 200, { machines });
            return;
          }
          if (url.pathname === "/api/conversation") {
            const target = containedTranscript(
              url.searchParams.get("path") ?? "",
            );
            if (Array.isArray(target)) {
              json(res, target[0], { error: target[1] });
              return;
            }
            json(res, 200, chats.view(target));
            return;
          }
          if (url.pathname === "/api/session") {
            const path = url.searchParams.get("path") ?? "";
            const requestedHost = url.searchParams.get("host") || undefined;
            const showAll = url.searchParams.get("all") === "1";
            let resolvedHost: string | undefined;
            let targetPath = path;

            if (requestedHost) {
              resolvedHost = resolveConfiguredHost(requestedHost, hosts);
              if (!resolvedHost) {
                json(res, 403, { error: "unknown host" });
                return;
              }
            } else {
              const target = containedTranscript(path);
              if (Array.isArray(target)) {
                json(res, target[0], { error: target[1] });
                return;
              }
              targetPath = target;
            }

            const lines: Line[] = resolvedHost
              ? await renderRemoteTranscript(
                  resolvedHost,
                  targetPath,
                  100,
                  showAll,
                  false,
                )
              : renderTranscript(targetPath, 100, showAll, false);
            json(res, 200, { lines });
            return;
          }
        } catch (error) {
          if (clientId && sent.get(clientId)?.value === undefined)
            sent.delete(clientId);
          json(res, 500, { error: (error as Error).message });
          return;
        }
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    },
  );

  server.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(prune);
    monitor.stop();
    workspace.close();
  });
  return { server, token, monitor, workspace };
}

/** The daemon keeps one URL token, so open tabs survive a restart. */
function daemonToken() {
  const file = join(monitorDir(), "token");
  try {
    const saved = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{32}$/.test(saved)) return saved;
  } catch {}
  mkdirSync(monitorDir(), { recursive: true, mode: 0o700 });
  const token = randomBytes(16).toString("hex");
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

export function serveWeb(
  hosts: string[],
  port: number,
  background = false,
): Promise<number> {
  const existing = serviceState();
  if (!background && existing) {
    openBrowser(`http://127.0.0.1:${existing.port}/?t=${existing.token}`);
    console.log(`Dashboard: http://127.0.0.1:${existing.port}/`);
    return Promise.resolve(0);
  }
  const { server, token, monitor, workspace } = createWebServer(
    hosts,
    port,
    background ? daemonToken() : undefined,
  );
  return new Promise((_resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${port}/`;
      debug(`web server listening on ${url}`);
      console.log(`context-find dashboard: ${url}\nCtrl-C to stop`);
      if (background) {
        mkdirSync(monitorDir(), { recursive: true, mode: 0o700 });
        writeFileSync(
          join(monitorDir(), "service.json"),
          JSON.stringify({ pid: process.pid, port, token }),
          { mode: 0o600 },
        );
        monitor.start();
      } else openBrowser(url + `?t=${token}`);
      const stop = () => {
        if (background)
          rmSync(join(monitorDir(), "service.json"), { force: true });
        monitor.stop();
        workspace.close();
        server.closeAllConnections();
        server.close();
        setTimeout(() => process.exit(0), 1000).unref();
      };
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    });
    // resolves only if the server closes; Ctrl-C ends the process
    server.on("close", () => _resolve(0));
  });
}
