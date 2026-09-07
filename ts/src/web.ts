/**
 * Read-only browser view: search the same corpus, read a rendered conversation.
 *
 * Localhost only. Transcripts hold whatever you have pasted into a prompt, so
 * this must never be reachable off the machine: the socket binds 127.0.0.1, and
 * every /api call carries a per-run token so another site in your browser cannot
 * drive it. Resume is deliberately absent - a browser has no terminal to hand a
 * conversation back to; that is the CLI's job, and v2's.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { platform } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import { debug } from "./debug.ts";
import { remoteConversationCounts, hostDisplayName, lastPingedAt, recordPing, renderRemoteTranscript } from "./remote.ts";
import { relativeTime, codexRoots, conversationCounts, projectsRoots, prettyPath, renderTranscript, sessionId,
         type Line, type Session } from "./store.ts";
import { Search } from "./search.ts";

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(text);
}

/** Best-effort open in the default browser; the URL is always printed too. */
function openBrowser(url: string): void {
  const cmd = platform() === "darwin" ? "open"
    : platform() === "win32" ? "cmd" : "xdg-open";
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

export function isPathContained(targetPath: string, parentDir: string): boolean {
  const rel = relative(parentDir, targetPath);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export function createWebServer(
  hosts: string[],
  port = 0,
  token = randomBytes(16).toString("hex"),
) {
  const localRoots = [...projectsRoots(), ...codexRoots()].map((r) => resolve(r));

  const asRow = (s: Session) => ({
    path: s.path, source: s.source, cwd: s.cwd, branch: s.branch,
    summary: s.summary, mtime: s.mtime, sid: sessionId(s),
    host: s.host ? hostDisplayName(s.host) : null,
    hostLabel: s.host != null ? hostDisplayName(s.host) : null,
    pretty: prettyPath(s.cwd),
  });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const addr = server.address();
    const currentPort = addr && typeof addr === "object" ? addr.port : port;
    if (!isPermittedHost(req.headers.host, currentPort)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("forbidden: invalid host header");
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${currentPort}`);

    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE.replace("__TOKEN__", token));
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      // localhost + unguessable token: another origin cannot read the token, so
      // it cannot reach this corpus even though the port is open on the machine.
      if (url.searchParams.get("t") !== token) {
        json(res, 403, { error: "forbidden" });
        return;
      }
      try {
        if (url.pathname === "/api/search") {
          const q = url.searchParams.get("q") ?? "";
          const search = new Search(q, hosts);
          await search.wait();
          json(res, 200, {
            sessions: search.sessions.map(asRow),
            errors: search.errors.map(([host, message]) => ({ host, message })),
          });
          return;
        }
        if (url.pathname === "/api/machines") {
          const row = (name: string, tally: Record<string, number> | null,
                       status: string, error: string | null) => ({
            name,
            claude: tally ? tally["claude"] ?? 0 : null,
            codex: tally ? tally["codex"] ?? 0 : null,
            total: tally ? (tally["claude"] ?? 0) + (tally["codex"] ?? 0) : null,
            last: tally ? relativeTime(tally["last"]) : null,
            status, error,
          });
          const machines = [row("this machine", conversationCounts(), "ready", null)];
          await Promise.all(hosts.map(async (spec) => {
            try {
              const tally = await remoteConversationCounts(spec);
              recordPing(spec);
              machines.push(row(hostDisplayName(spec), tally, `last pinged ${relativeTime(lastPingedAt(spec))}`, null));
            } catch (error) {
              const last = lastPingedAt(spec);
              machines.push(row(hostDisplayName(spec), null,
                last ? `unreachable, last ok ${relativeTime(last)}` : "unreachable",
                (error as Error).message));
            }
          }));
          json(res, 200, { machines });
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
            const realTarget = safeRealPath(resolve(path));
            if (!realTarget) {
              json(res, 404, { error: "path not found" });
              return;
            }
            const realRoots = localRoots
              .map(safeRealPath)
              .filter((r): r is string => r !== null);
            const inside = realRoots.some((r) => isPathContained(realTarget, r));
            if (!inside) {
              json(res, 403, { error: "path outside transcript stores" });
              return;
            }
            targetPath = realTarget;
          }

          const lines: Line[] = resolvedHost
            ? await renderRemoteTranscript(resolvedHost, targetPath, 100, showAll, false)
            : renderTranscript(targetPath, 100, showAll, false);
          json(res, 200, { lines });
          return;
        }
      } catch (error) {
        json(res, 500, { error: (error as Error).message });
        return;
      }
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  return { server, token };
}

export function serveWeb(hosts: string[], port: number): Promise<number> {
  const { server, token } = createWebServer(hosts, port);
  return new Promise((_resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${port}/`;
      debug(`web server listening on ${url}`);
      console.log(`context-find web: ${url}\nread-only; Ctrl-C to stop`);
      openBrowser(url + `?t=${token}`);
    });
    // resolves only if the server closes; Ctrl-C ends the process
    server.on("close", () => _resolve(0));
  });
}

// Single self-contained page. Vanilla JS, terminal palette to match the TUI.
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>context-find</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; display: grid; grid-template-columns: 420px 1fr;
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #0d0d10; color: #d8d8dc; }
  #left { border-right: 1px solid #26262c; display: flex; flex-direction: column; min-height: 0; }
  #bar { display: flex; gap: 6px; margin: 10px; }
  #q { flex: 1; min-width: 0; padding: 8px 10px; background: #16161b; border: 1px solid #26262c;
    color: #d8d8dc; border-radius: 6px; font: inherit; }
  #go { padding: 0 12px; background: #16161b; border: 1px solid #26262c; color: #c678dd;
    border-radius: 6px; font: inherit; cursor: pointer; }
  #go:hover { background: #1e1e26; border-color: #c678dd; }
  #nav { margin: 0 10px 8px; font-size: 12px; }
  #nav a { color: #6a6a72; cursor: pointer; text-decoration: none; }
  #nav a:hover { color: #c678dd; }
  #list { overflow-y: auto; flex: 1; }
  table.mt { border-collapse: collapse; font-size: 13px; }
  table.mt th, table.mt td { text-align: left; padding: 4px 16px 4px 0; border-bottom: 1px solid #1b1b20; }
  table.mt th { color: #6a6a72; font-weight: 400; }
  table.mt td.n { text-align: right; }
  .row { padding: 8px 12px; border-bottom: 1px solid #1b1b20; cursor: pointer; }
  .row:hover { background: #16161b; }
  .row.sel { background: #1e1e26; }
  .row .top { display: flex; gap: 8px; font-size: 12px; color: #888; }
  .row .sum { color: #d8d8dc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge { font-weight: 700; }
  .claude { color: #e06c75; } .codex { color: #98c379; }
  .host { color: #c678dd; }
  #right { display: flex; flex-direction: column; min-height: 0; position: relative; }
  #rsearch { display: none; gap: 6px; padding: 6px 12px; background: #16161b;
    border-bottom: 1px solid #26262c; align-items: center; }
  #rsearch.open { display: flex; }
  #rsearch input { flex: 1; min-width: 0; padding: 6px 8px; background: #0d0d10;
    border: 1px solid #26262c; color: #d8d8dc; border-radius: 4px; font: inherit; font-size: 13px; }
  #rsearch input:focus { border-color: #c678dd; outline: none; }
  #rsearch .info { font-size: 12px; color: #6a6a72; white-space: nowrap; min-width: 80px; text-align: right; }
  #rsearch button { background: none; border: 1px solid #26262c; color: #d8d8dc; border-radius: 4px;
    padding: 2px 8px; font: inherit; font-size: 13px; cursor: pointer; line-height: 1.4; }
  #rsearch button:hover { background: #1e1e26; border-color: #c678dd; color: #c678dd; }
  mark.hit { background: #5c4a16; color: #d8d8dc; border-radius: 2px; }
  mark.hit.cur { background: #c678dd; color: #0d0d10; }
  #reader { overflow-y: auto; padding: 16px 24px; white-space: pre-wrap; word-break: break-word; flex: 1; }
  #reader .user { color: #c678dd; font-weight: 700; }
  #reader .assistant { color: #56b6c2; font-weight: 700; }
  #reader .tool { color: #98c379; }
  #reader .meta { color: #6a6a72; }
  #hint { color: #6a6a72; padding: 24px; }
  #err { color: #e06c75; padding: 0 12px; font-size: 12px; }
</style></head>
<body>
  <div id="left">
    <form id="bar">
      <input id="q" placeholder="search transcripts" autofocus autocomplete="off">
      <button id="go" type="submit" title="deep search (Enter)">&#9166;</button>
    </form>
    <div id="nav"><a id="mach">&#9776; machines</a></div>
    <div id="err"></div>
    <div id="list"></div>
  </div>
  <div id="right">
    <div id="rsearch">
      <input id="rq" placeholder="find in conversation…" autocomplete="off">
      <button id="rprev" title="previous (Shift+Enter)">&#9650;</button>
      <button id="rnext" title="next (Enter)">&#9660;</button>
      <span class="info" id="rinfo"></span>
      <button id="rclose" title="close (Esc)">&#10005;</button>
    </div>
    <div id="reader"><div id="hint">Search on the left, click a conversation to read it.</div></div>
  </div>
<script>
const T = "__TOKEN__";
const list = document.getElementById("list");
const reader = document.getElementById("reader");
const err = document.getElementById("err");
const q = document.getElementById("q");
let rows = [], sel = -1;

function esc(s){ return s.replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }

async function search(){
  err.textContent = "searching...";
  try {
    const r = await fetch("/api/search?t="+T+"&q="+encodeURIComponent(q.value));
    const d = await r.json();
    rows = d.sessions || [];
    err.textContent = (d.errors||[]).map(e => e.host+": "+e.message).join("  ") ;
    draw();
  } catch(e){ err.textContent = String(e); }
}

function draw(){
  list.innerHTML = "";
  rows.forEach((s, i) => {
    const div = document.createElement("div");
    div.className = "row" + (i===sel ? " sel" : "");
    const when = new Date(s.mtime*1000).toLocaleString();
    const host = s.hostLabel ? '<span class="host">'+esc(s.hostLabel)+'</span>' : 'local';
    div.innerHTML = '<div class="top"><span class="badge '+s.source+'">'+s.source+'</span>'
      + '<span>'+when+'</span>'+host+'<span>'+esc(s.branch)+'</span></div>'
      + '<div class="top">'+esc(s.pretty)+'</div>'
      + '<div class="sum">'+esc(s.summary)+'</div>';
    div.onclick = () => open(i);
    list.appendChild(div);
  });
}

async function open(i){
  sel = i; draw();
  rClear(); readerRaw = "";
  const s = rows[i];
  reader.innerHTML = '<div id="hint">loading...</div>';
  try {
    const u = "/api/session?t="+T+"&path="+encodeURIComponent(s.path)
      + (s.host ? "&host="+encodeURIComponent(s.host) : "");
    const d = await (await fetch(u)).json();
    if (d.error){ reader.innerHTML = '<div id="hint">'+esc(d.error)+'</div>'; return; }
    reader.innerHTML = d.lines.map(([style, text]) =>
      '<span class="'+style+'">'+esc(text)+'</span>').join("\\n");
    reader.scrollTop = 0;
  } catch(e){ reader.innerHTML = '<div id="hint">'+esc(String(e))+'</div>'; }
}

async function machines(){
  reader.innerHTML = '<div id="hint">reading machines...</div>';
  try {
    const d = await (await fetch("/api/machines?t="+T)).json();
    if (d.error){ reader.innerHTML = '<div id="hint">'+esc(d.error)+'</div>'; return; }
    const cell = v => v===null ? "-" : v;
    reader.innerHTML = '<table class="mt"><thead><tr>'
      + '<th>machine</th><th>claude</th><th>codex</th><th>total</th><th>last used</th><th>status</th>'
      + '</tr></thead><tbody>'
      + (d.machines||[]).map(m => '<tr><td>'+esc(m.name)+'</td>'
          + '<td class="n">'+cell(m.claude)+'</td><td class="n">'+cell(m.codex)+'</td>'
          + '<td class="n">'+cell(m.total)+'</td><td>'+esc(cell(m.last))+'</td>'
          + '<td>'+esc(m.status)+(m.error ? ' - '+esc(m.error) : '')+'</td></tr>').join("")
      + '</tbody></table>';
    reader.scrollTop = 0;
  } catch(e){ reader.innerHTML = '<div id="hint">'+esc(String(e))+'</div>'; }
}

// ── In-conversation search ──────────────────────────────────────────────
const rsearch = document.getElementById("rsearch");
const rq = document.getElementById("rq");
const rinfo = document.getElementById("rinfo");
let readerRaw = "";          // original HTML before highlights
let rmatches = [];           // NodeList turned array of <mark> elements
let rcur = -1;               // currently focused match index

function rOpen(){
  rsearch.classList.add("open");
  rq.focus();
  rq.select();
}
function rClose(){
  rsearch.classList.remove("open");
  rClear();
  rq.value = "";
}
function rClear(){
  if (readerRaw){ reader.innerHTML = readerRaw; readerRaw = ""; }
  rmatches = []; rcur = -1;
  rinfo.textContent = "";
}

function rHighlight(){
  const needle = rq.value.trim();
  rClear();
  if (!needle) return;
  // Save original content before we mutate it
  readerRaw = reader.innerHTML;
  // Walk text nodes and wrap matches
  const escaped = needle.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
  const re = new RegExp("(" + escaped + ")", "gi");
  const walker = document.createTreeWalker(reader, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (!re.test(node.textContent)) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    node.textContent.replace(re, (m, g, off) => {
      if (off > last) frag.appendChild(document.createTextNode(node.textContent.slice(last, off)));
      const mark = document.createElement("mark");
      mark.className = "hit";
      mark.textContent = m;
      frag.appendChild(mark);
      last = off + m.length;
      return m;
    });
    if (last < node.textContent.length) frag.appendChild(document.createTextNode(node.textContent.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
  rmatches = Array.from(reader.querySelectorAll("mark.hit"));
  if (rmatches.length){ rcur = 0; rShow(); }
  else { rinfo.textContent = "no matches"; }
}

function rShow(){
  rmatches.forEach((m,i) => { m.classList.toggle("cur", i === rcur); });
  rinfo.textContent = rmatches.length ? (rcur+1) + " / " + rmatches.length : "no matches";
  if (rmatches[rcur]) rmatches[rcur].scrollIntoView({ block: "center", behavior: "smooth" });
}
function rNext(){ if (!rmatches.length) return; rcur = (rcur+1) % rmatches.length; rShow(); }
function rPrev(){ if (!rmatches.length) return; rcur = (rcur - 1 + rmatches.length) % rmatches.length; rShow(); }

rq.addEventListener("input", rHighlight);
rq.addEventListener("keydown", e => {
  if (e.key === "Enter"){ e.preventDefault(); e.shiftKey ? rPrev() : rNext(); }
  if (e.key === "Escape"){ e.preventDefault(); rClose(); }
});
document.getElementById("rnext").addEventListener("click", rNext);
document.getElementById("rprev").addEventListener("click", rPrev);
document.getElementById("rclose").addEventListener("click", rClose);

document.addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && e.key === "f"){
    // Only intercept when a conversation is loaded (not showing the hint)
    if (reader.querySelector("#hint")) return;
    e.preventDefault();
    rOpen();
  }
});


// A form submit fires on Enter in the field and on the button, in every browser.
document.getElementById("bar").addEventListener("submit", e => { e.preventDefault(); search(); });
document.getElementById("mach").addEventListener("click", machines);
search();
</script>
</body></html>`;
