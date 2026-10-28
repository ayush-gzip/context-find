"use strict";
const $ = (s, r = document) => r.querySelector(s),
  $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const T = window.CFIND_TOKEN;
history.replaceState(null, "", location.pathname + location.hash);
const S = {
  page: location.hash.slice(1) || "overview",
  metrics: null,
  workspace: { agents: [], logins: [] },
  accounts: [],
  days: 14,
  profile: "all",
  search: "",
  project: "all",
  sessions: [],
  remoteErrors: [],
  view: null,
  chat: null,
  /** Pushes the open local chat's new messages (watchChat). */
  chatStream: null,
  drafts: {},
  images: {},
  /** Sent messages the chat does not show yet, by chat key. */
  outbox: {},
  // The / menu per profile and folder: a list, null while it loads, or an error.
  commands: {},
  slashAt: 0,
  chatFull: localStorage.getItem("cfind-chat-size") !== "panel",
  // Agents whose subagents the user unfolded.
  openKids: new Set(),
  phones: { devices: [] },
  uploads: null,
  pairing: null,
  login: null,
  limit: 100,
};
const colors = { claude: "#d77b56", personal: "#a17bd0", codex: "#577be5" },
  labels = {
    overview: "Overview",
    workspace: "Agents",
    sessions: "Sessions",
    machines: "Machines",
    settings: "Connections",
  };
const formatter = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const num = (n) => formatter.format(n || 0),
  full = (n) => Number(n || 0).toLocaleString();
const total = (t, p) =>
  (t?.input || 0) +
  (t?.output || 0) +
  (p === "codex" ? 0 : (t?.created || 0) + (t?.cached || 0));
const age = (t) => {
  if (!t) return "Unknown";
  const d = Math.max(0, (Date.now() - t) / 1000);
  return d < 60
    ? `${Math.floor(d)}s ago`
    : d < 3600
      ? `${Math.floor(d / 60)}m ago`
      : d < 86400
        ? `${Math.floor(d / 3600)}h ago`
        : `${Math.floor(d / 86400)}d ago`;
};
const elapsed = (t) => {
  const d = Math.max(0, Date.now() - t) / 1000;
  return d < 60
    ? `${Math.floor(d)}s`
    : d < 3600
      ? `${Math.floor(d / 60)}m ${Math.floor(d % 60)}s`
      : `${Math.floor(d / 3600)}h ${Math.floor((d % 3600) / 60)}m`;
};
const folder = (p) =>
  /^\/(Users|home)\/[^/]+\/?$/.test(p || "")
    ? "~"
    : String(p || "Unknown project")
        .split(/[\\/]/)
        .filter(Boolean)
        .slice(-2)
        .join("/");
const state = (s) =>
  ({
    idle: "Idle",
    unknown: "Unknown",
    running: "Running",
    queued: "Queued",
    waiting: "Needs input",
    asking: "Needs your answer",
    failed: "Failed",
    complete: "Complete",
    completed: "Complete",
    stopped: "Stopped",
    stale: "Stale",
    errored: "Failed",
    shutdown: "Stopped",
    finished: "Complete",
    pending_init: "Starting",
  })[s] || s;
const profileLabel = (id) =>
  S.metrics?.profiles.find((p) => p.id === id)?.label || id;
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("#toast").hidden = true), 6000);
}
async function api(path, body) {
  const r = await fetch(
    "/api/" +
      path +
      (path.includes("?") ? "&" : "?") +
      "t=" +
      encodeURIComponent(T),
    body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  const data = await r.json();
  if (!r.ok || data.error)
    throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}
function connect() {
  // The first metrics and workspace events are whole; the -delta ones after them
  // carry only what changed (src/delta.ts).
  const stream = new EventSource(
    "/api/events?delta=1&t=" + encodeURIComponent(T),
  );
  stream.onopen = () => {
    $("#live-badge").className = "live-badge";
    $("#live-badge").innerHTML = "<i></i> Live";
    $("#collector-dot").style.background = "";
  };
  stream.onerror = () => {
    $("#live-badge").className = "live-badge offline";
    $("#live-badge").innerHTML = "<i></i> Reconnecting";
    $("#collector-dot").style.background = "#dba379";
    $("#collector-state").innerHTML =
      "Connection lost<small>Reconnecting automatically</small>";
  };
  const onMetrics = () => {
    updateStatus();
    render();
    followSession();
  };
  const onWorkspace = () => {
    updateStatus();
    render();
    renderChat();
    updateLogin();
  };
  stream.addEventListener("metrics", (e) => {
    S.metrics = JSON.parse(e.data);
    onMetrics();
  });
  stream.addEventListener("metrics-delta", (e) => {
    if (!S.metrics) return;
    S.metrics = cfindDelta.applyDelta(S.metrics, JSON.parse(e.data));
    onMetrics();
  });
  stream.addEventListener("workspace", (e) => {
    S.workspace = JSON.parse(e.data);
    onWorkspace();
  });
  stream.addEventListener("workspace-delta", (e) => {
    S.workspace = cfindDelta.applyDelta(S.workspace, JSON.parse(e.data));
    onWorkspace();
  });
}
function updateStatus() {
  const m = S.metrics;
  if (!m) return;
  $("#footer-sources").textContent =
    `${m.profiles.length} SOURCES · ${m.sessions.length} SESSIONS`;
  $("#footer-update").textContent = `Updated ${age(m.updatedAt)}`;
  $("#collector-state").innerHTML =
    `Collector connected<small>${m.collecting ? "Reading local records" : "Local records are current"}</small>`;
  $("#agent-count").textContent = allAgents().filter((a) =>
    ["running", "waiting", "queued"].includes(a.state),
  ).length;
}
function sourceOptions() {
  return (
    '<option value="all">All profiles</option>' +
    (S.metrics?.profiles || [])
      .map(
        (p) =>
          `<option value="${esc(p.id)}" ${p.id === S.profile ? "selected" : ""}>${esc(p.label)}</option>`,
      )
      .join("")
  );
}
function toolbar() {
  return `<div class="toolbar"><select data-profile aria-label="Profile">${sourceOptions()}</select><select data-days aria-label="Date range">${[7, 14, 30, 90, 0].map((d) => `<option value="${d}" ${d === S.days ? "selected" : ""}>${d ? `Last ${d} days` : "All time"}</option>`).join("")}</select></div>`;
}
function heading(eyebrow, title, subtitle, controls = toolbar()) {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${controls}</div>`;
}
function inScope(p) {
  return S.profile === "all" || p === S.profile;
}
function cutoff() {
  if (!S.days) return "";
  const d = new Date();
  d.setDate(d.getDate() - S.days + 1);
  return d.toLocaleDateString("en-CA");
}
function scopedDays() {
  const start = cutoff();
  return (S.metrics?.days || []).filter(
    (d) => inScope(d.profile) && (!start || d.day >= start),
  );
}
function scopedSessions() {
  const start = cutoff();
  return (S.metrics?.sessions || []).filter(
    (s) =>
      inScope(s.profile) &&
      (S.project === "all" || s.cwd === S.project) &&
      (!start || new Date(s.updatedAt).toLocaleDateString("en-CA") >= start),
  );
}
function sums() {
  return scopedDays().reduce(
    (t, d) => ({
      input: t.input + d.tokens.input,
      output: t.output + d.tokens.output,
      cached: t.cached + d.tokens.cached,
      created: t.created + d.tokens.created,
      total: t.total + total(d.tokens, d.profile),
    }),
    { input: 0, output: 0, cached: 0, created: 0, total: 0 },
  );
}
function empty(title, description, button = false) {
  return `<div class="empty"><span class="empty-symbol">⌘</span><h3>${title}</h3><p>${description}</p>${button ? '<button class="button light" data-new>＋ Start an agent</button>' : ""}</div>`;
}
function resetTime(q) {
  if (!q) return "Open a session to collect usage";
  const d = q.resetsAt * 1000 - Date.now();
  if (d <= 0) return "Awaiting refresh";
  return d < 3600000
    ? `${Math.ceil(d / 60000)}m to reset`
    : d < 86400000
      ? `${Math.floor(d / 3600000)}h ${Math.floor((d % 3600000) / 60000)}m to reset`
      : `${Math.floor(d / 86400000)}d ${Math.floor((d % 86400000) / 3600000)}h to reset`;
}
function quotaLine(label, q) {
  const valid = q && q.resetsAt * 1000 > Date.now(),
    left = valid ? Math.round(100 - q.used) : null;
  return `<div class="quota-line"><div class="labels"><span>${label}<small data-reset="${esc(JSON.stringify(q || null))}">${resetTime(q)}</small></span><strong>${left === null ? "—" : left + "%"}<span class="sr-only"> remaining</span></strong></div><div class="meter" role="meter" aria-label="${label} quota remaining" ${left !== null ? `aria-valuenow="${left}" aria-valuemin="0" aria-valuemax="100"` : ""}><span style="width:${left || 0}%"></span></div></div>`;
}
function quotaCards() {
  return `<div class="quota-grid">${[...(S.metrics?.profiles || [])]
    .sort(
      (a, b) =>
        ["claude", "personal", "codex"].indexOf(a.id) -
        ["claude", "personal", "codex"].indexOf(b.id),
    )
    .map((p) => {
      const a = S.accounts.find((a) => a.profile === p.id),
        l = p.limits,
        q = l?.session,
        valid = q && q.resetsAt * 1000 > Date.now(),
        left = valid ? Math.round(100 - q.used) : null;
      return `<article class="panel quota-card ${p.id === "codex" ? "codex" : p.id === "personal" ? "personal" : "claude"}"><div class="card-top"><div class="source-title"><span class="source-logo">${sourceIcon(p.source)}</span><div>${p.source === "codex" ? "Codex" : "Claude"}<small>${p.id === "personal" ? "Personal" : p.source === "claude" ? "Default profile" : "ChatGPT"}</small></div></div><span class="plan-pill">${esc(l?.plan || a?.plan || "Local")}</span></div><div class="quota-summary"><div class="quota-number ${left === null ? "unavailable" : ""}">${left === null ? "Not available" : left + "<span>%</span>"}</div><div class="quota-caption">${left === null ? "Waiting for session telemetry" : "Session remaining"}</div></div><div class="meter"><span style="width:${left || 0}%"></span></div><div class="quota-reset" data-reset="${esc(JSON.stringify(q || null))}">${resetTime(q)}</div><div class="weekly-usage"><span>Weekly remaining</span><strong>${l?.week && l.week.resetsAt * 1000 > Date.now() ? Math.round(100 - l.week.used) + "%" : "—"}</strong></div><div class="meter weekly-meter"><span style="width:${l?.week && l.week.resetsAt * 1000 > Date.now() ? 100 - l.week.used : 0}%"></span></div><div class="quota-foot"><span>${l ? "Updated " + age(l.observedAt) : "Updates from local agent events"}</span><span title="All recorded token usage">${num(total(p.tokens, p.id))} tokens</span></div></article>`;
    })
    .join("")}</div>`;
}
function chart() {
  const byDay = new Map();
  for (const d of scopedDays()) {
    if (!byDay.has(d.day)) byDay.set(d.day, {});
    byDay.get(d.day)[d.profile] =
      (byDay.get(d.day)[d.profile] || 0) + total(d.tokens, d.profile);
  }
  const days = [],
    count = S.days || 0;
  if (!S.days) days.push(...[...byDay.keys()].sort());
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toLocaleDateString("en-CA"));
  }
  const max = Math.max(
      1,
      ...days.map((d) =>
        Object.values(byDay.get(d) || {}).reduce((s, v) => s + v, 0),
      ),
    ),
    t = sums();
  return `<div class="panel"><div class="panel-head"><h2 class="panel-title">Usage over time <span class="faint">↗</span></h2><div class="legend">${(
    S.metrics?.profiles || []
  )
    .filter((p) => inScope(p.id))
    .map(
      (p) =>
        `<span><i style="background:${colors[p.id] || colors.claude}"></i>${esc(p.id === "personal" ? "Personal" : p.id === "claude" ? "Default" : p.label)}</span>`,
    )
    .join(
      "",
    )}</div></div><div class="stat-row"><div><div class="stat-label">Total tokens</div><div class="stat-value">${num(t.total)}</div><div class="stat-note">In selected period</div></div><div><div class="stat-label">Input</div><div class="stat-value">${num(t.input)}</div><div class="stat-note">Prompts and context</div></div><div><div class="stat-label">Output</div><div class="stat-value">${num(t.output)}</div><div class="stat-note">Written by agents</div></div><div><div class="stat-label">Cache</div><div class="stat-value">${num(t.cached + t.created)}</div><div class="stat-note">${num(t.cached)} read · ${num(t.created)} written</div></div><div><div class="stat-label">Sessions</div><div class="stat-value">${full(scopedSessions().length)}</div><div class="stat-note">In the selected period</div></div></div><div class="chart-wrap"><div class="chart" role="img" aria-label="Daily token usage by profile">${days
    .map((d) => {
      const values = byDay.get(d) || {},
        sum = Object.values(values).reduce((s, v) => s + v, 0);
      return `<div class="chart-col" tabindex="0" aria-label="${d}: ${full(sum)} tokens"><div class="chart-tooltip">${esc(d)} · ${num(sum)} tokens</div>${Object.entries(
        values,
      )
        .map(
          ([p, v]) =>
            `<span style="height:${Math.max(0.4, (v / max) * 100)}%;background:${colors[p] || colors.claude}"></span>`,
        )
        .join("")}</div>`;
    })
    .join(
      "",
    )}</div><div class="chart-labels"><span>${days[0]?.slice(5)}</span><span>${days[Math.floor(days.length / 2)]?.slice(5)}</span><span>Today</span></div></div><div class="chart-caption">Local calendar days · Counts come from recorded usage, not billing.</div></div>`;
}
const recentFirst = (a, b) =>
  (b.updatedAt || b.startedAt || 0) - (a.updatedAt || a.startedAt || 0) ||
  `${a.profile || ""}|${a.id}`.localeCompare(`${b.profile || ""}|${b.id}`);
/** A turn that ended on a question (`cfind ask`, or the reply asks) shows as its own state. */
const shownState = (x) => (x.ask && x.state === "idle" ? "asking" : x.state);
function allAgents() {
  const owned = S.workspace.agents.map((a) => ({
      ...a,
      state: shownState(a),
      owned: true,
      children: [...a.children].sort(recentFirst),
    })),
    ids = new Set(owned.map((a) => a.profile + "|" + a.sid));
  const observed = (S.metrics?.sessions || [])
    .filter(
      (s) =>
        !s.parent &&
        !ids.has(s.profile + "|" + s.id) &&
        (s.open ||
          ["running", "waiting", "stale"].includes(s.state) ||
          // A closed session that asked today still waits for an answer.
          (s.ask && Date.now() - s.updatedAt < 24 * 3600 * 1000)),
    )
    .map((s) => ({
      ...s,
      state: shownState(s),
      sid: s.id,
      owned: false,
      // An idle session's old subagents are done unless they still report.
      children: (S.metrics?.sessions || [])
        .filter(
          (c) =>
            c.profile === s.profile &&
            c.parent === s.id &&
            (s.state !== "idle" || ["running", "waiting"].includes(c.state)),
        )
        .map((c) => ({
          id: c.id,
          task: c.title,
          state: c.state,
          model: c.model,
          updatedAt: c.updatedAt,
        }))
        .sort(recentFirst),
    }));
  return [...owned, ...observed]
    .filter((a) => inScope(a.profile))
    .sort(recentFirst);
}
function kids(children) {
  const live = children.filter((c) =>
    ["running", "waiting"].includes(c.state),
  ).length;
  return `${children.length} subagent${children.length === 1 ? "" : "s"}${live ? ` · ${live} running` : ""}`;
}
function agentCard(a) {
  return `<div><button class="agent-card" data-agent="${esc(a.id)}" data-owned="${a.owned ? "1" : "0"}" data-profile-id="${esc(a.profile)}" style="width:100%"><div class="agent-top"><span><i class="state-dot ${esc(a.state)}"></i>${esc(state(a.state))}</span><span>${a.owned ? "In workspace" : "External session"}</span></div><h3>${esc(a.title || "Agent session")}</h3><div class="agent-meta">${esc(folder(a.cwd))}</div><div class="agent-bottom"><span style="color:${colors[a.profile] || colors.claude}">${esc(profileLabel(a.profile))}</span><span>${esc(a.model || "Default model")} · ${elapsed(a.startedAt)}</span></div>${a.queue?.length ? `<div class="agent-meta" style="margin-top:12px">${a.queue.length} prompt${a.queue.length === 1 ? "" : "s"} queued</div>` : ""}</button>${a.children?.length ? `<details class="subagents" data-parent="${esc(a.id)}"${S.openKids.has(a.id) ? " open" : ""}><summary>${kids(a.children)}</summary><div class="agent-children">${a.children.map((c) => `<div class="child-card" role="button" tabindex="0" data-child="${esc(c.id)}" data-profile-id="${esc(a.profile)}"><span class="child-task"><span class="state-dot ${esc(c.state)}"></span> ${esc(c.task)}</span><small><span>↳ ${esc(state(c.state))}</span><span>${esc(c.model || "Subagent")}</span></small></div>`).join("")}</div></details>` : ""}</div>`;
}
function activeCanvas() {
  const agents = allAgents().filter((a) =>
    ["running", "waiting", "asking", "queued", "stale"].includes(a.state),
  );
  return `<div class="section-heading"><h2>Active agents <span class="count">${agents.length}</span></h2><span class="section-sub">Including subagents</span></div><div class="canvas">${agents.length ? `<div class="agent-grid">${agents.map(agentCard).join("")}</div>` : empty("No agents running", "Start a new agent to see its progress here.", true)}</div>`;
}
function activity() {
  const signals = (S.metrics?.activity || []).filter((a) => inScope(a.profile)),
    events = [
      ...signals.map((a) => ({
        title: a.agentType ? `${a.agentType} · ${a.event}` : a.event,
        detail: profileLabel(a.profile) + " · " + folder(a.cwd),
        time: a.updatedAt,
        profile: a.profile,
      })),
      ...(S.metrics?.sessions || [])
        .filter((s) => inScope(s.profile) && !s.parent)
        .slice(0, 5)
        .map((a) => ({
          title: a.title,
          detail: profileLabel(a.profile) + " · " + folder(a.cwd),
          time: a.updatedAt,
          profile: a.profile,
        })),
    ]
      .sort((a, b) => b.time - a.time)
      .slice(0, 5);
  return `<div class="panel activity-panel"><div class="panel-head"><h2 class="panel-title">Recent activity</h2><span class="online-dot"></span></div><div class="activity-list">${events.length ? events.map((e) => `<div class="activity-row"><span class="activity-icon" style="--accent:${colors[e.profile] || colors.claude}">${sourceIcon(e.profile === "codex" ? "codex" : "claude")}</span><div class="activity-details"><b>${esc(e.title)}</b><small>${esc(e.detail)}</small></div><time>${age(e.time)}</time></div>`).join("") : empty("Listening for activity", "New agent events will appear here.")}</div><div class="chart-caption">Live events from local sessions</div></div>`;
}
function sessionsTable(rows, limited = true) {
  const shown = rows.slice(0, limited ? S.limit : 8);
  return `<div class="panel"><div class="table-wrap"><table><thead><tr><th>Conversation</th><th>Account</th><th>Model</th><th>Tokens</th><th>Last active</th><th></th></tr></thead><tbody>${shown.map((s) => `<tr data-session="${esc(s.id || s.sid)}" data-profile-id="${esc(s.profile || s.source)}" data-path="${esc(s.path)}" data-host="${esc(s.host || "")}" tabindex="0"><td><div class="session-name">${esc(s.title || s.summary)}<small>${esc(folder(s.cwd))}${s.parent ? " · subagent" : ""}</small></div></td><td><span class="source-chip" style="--accent:${colors[s.profile || s.source] || colors.claude}">${esc(profileLabel(s.profile || s.source))}</span></td><td class="numeric">${esc(s.model || "—")}</td><td class="numeric">${s.usageAvailable ? num(total(s.tokens, s.profile)) : "—"}</td><td class="numeric">${age(s.updatedAt || s.mtime * 1000)}</td><td>↗</td></tr>`).join("")}</tbody></table>${!rows.length ? empty("No sessions found", "Change the filters or search for another phrase.") : ""}</div><div class="table-note"><span>${shown.length} of ${rows.length} sessions · Select a row to read</span>${limited && rows.length > shown.length ? '<button class="button" data-more>Show more</button>' : ""}</div></div>`;
}
function overview() {
  return (
    heading(
      "",
      "Overview",
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    ) +
    quotaCards() +
    `<div class="dashboard-grid">${chart()}${activity()}</div>` +
    `<div class="dashboard-grid">${projectsPanel()}${modelsPanel()}</div>` +
    activeCanvas() +
    `<div class="section-heading"><h2>Recent sessions</h2><button class="button" data-page="sessions">View all sessions ↗</button></div>` +
    sessionsTable(scopedSessions(), false)
  );
}
function workspace() {
  const agents = allAgents(),
    lanes = [
      ["queued", "Queued"],
      ["running", "Running"],
      ["waiting", "Needs input"],
      ["done", "Idle"],
    ];
  return (
    heading(
      "",
      "Agents",
      "Your active sessions and the work happening inside them.",
      `<div class="toolbar"><select data-profile aria-label="Profile">${sourceOptions()}</select><button class="button light" data-new>＋ New agent</button></div>`,
    ) +
    `<div class="canvas"><div class="board">${lanes
      .map(([id, label]) => {
        const group = agents.filter((a) =>
          id === "done"
            ? !["queued", "running", "waiting", "asking", "stale"].includes(a.state)
            : id === "running"
              ? ["running", "stale"].includes(a.state)
              : id === "waiting"
                ? ["waiting", "asking"].includes(a.state)
                : a.state === id,
        );
        return `<section class="lane"><div class="lane-title"><span>${label}</span><span>${group.length}</span></div>${group.length ? group.map(agentCard).join("") : '<div class="lane-empty">No agents here</div>'}</section>`;
      })
      .join(
        "",
      )}</div></div><p class="usage-disclosure">Workspace agents support chat and stop controls. Observed sessions are read-only while active. A stale status means no recent event confirms the current state.</p>`
  );
}
function sessions() {
  const q = S.search.toLowerCase(),
    source = S.deepSearch ? S.sessions : scopedSessions(),
    rows = source.filter(
      (s) =>
        inScope(s.profile || s.source) &&
        (S.project === "all" || s.cwd === S.project) &&
        (!q ||
          S.deepSearch ||
          `${s.title || s.summary} ${s.cwd} ${s.model || ""}`
            .toLowerCase()
            .includes(q)),
    );
  return (
    heading("", "Sessions", "Every conversation, ready when you need it.") +
    `<form id="session-search" class="filters"><div class="searchbox"><span>⌕</span><input id="session-q" placeholder="Search conversations…" value="${esc(S.search)}" aria-label="Search conversations" autocomplete="off"></div><select data-profile aria-label="Profile">${sourceOptions()}</select><select data-project aria-label="Project"><option value="all">All projects</option>${[
      ...new Set((S.metrics?.sessions || []).map((s) => s.cwd).filter(Boolean)),
    ]
      .sort()
      .map(
        (p) =>
          `<option value="${esc(p)}" ${S.project === p ? "selected" : ""}>${esc(folder(p))}</option>`,
      )
      .join(
        "",
      )}</select><button class="button" type="submit">Search full text ↵</button>${S.deepSearch ? '<button class="button" type="button" data-clear-search>Clear</button>' : ""}<span class="muted small">${rows.length} sessions</span></form>${S.remoteErrors.length ? `<div class="warning-banner">${S.remoteErrors.map((e) => esc(e.host + ": " + e.message)).join("<br>")}</div>` : ""}${sessionsTable(rows)}`
  );
}
function modelsPanel() {
  const map = new Map(),
    cost = reportedCost();
  for (const u of scopedUsage()) {
    const key = u.model + "|" + u.profile,
      v = map.get(key) || { model: u.model, profile: u.profile, total: 0 };
    v.total += total(u.tokens, u.profile);
    map.set(key, v);
  }
  const models = [...map.values()]
      .sort((a, b) => b.total - a.total)
      .slice(0, 7),
    max = Math.max(1, ...models.map((m) => m.total));
  return `<div class="panel"><div class="panel-head"><h2 class="panel-title">Models</h2><small>Selected period</small></div><div class="model-list">${models.length ? models.map((m) => `<div class="model-row"><div class="labels"><span>${esc(m.model)} <span class="faint">· ${esc(profileLabel(m.profile))}</span></span><span>${num(m.total)}</span></div><div class="meter" style="--accent:${colors[m.profile] || colors.claude}"><span style="width:${(m.total / max) * 100}%"></span></div></div>`).join("") : empty("No usage records", "Model usage will appear after an agent response.")}</div>${cost === null ? "" : `<div class="chart-caption">Reported API value $${cost.toFixed(2)} · a list-price estimate, not your bill</div>`}</div>`;
}
function reportedCost() {
  const byId = new Map();
  for (const c of S.metrics?.costs || [])
    if (inScope(c.profile)) byId.set(c.profile + "|" + c.sessionId, c.value);
  for (const a of S.workspace.agents)
    if (inScope(a.profile) && typeof a.estimatedCostUsd === "number")
      byId.set(a.profile + "|" + a.sid, a.estimatedCostUsd);
  return byId.size ? [...byId.values()].reduce((a, b) => a + b, 0) : null;
}
function scopedUsage() {
  const start = cutoff();
  return (S.metrics?.usage || []).filter(
    (u) => inScope(u.profile) && (!start || u.day >= start),
  );
}
function projectsPanel() {
  const sessions = scopedSessions(),
    projects = new Map();
  for (const u of scopedUsage()) {
    const p = projects.get(u.cwd) || {
      tokens: 0,
      sessions: sessions.filter((s) => s.cwd === u.cwd).length,
    };
    p.tokens += total(u.tokens, u.profile);
    projects.set(u.cwd, p);
  }
  const rows = [...projects].sort((a, b) => b[1].tokens - a[1].tokens),
    shown = S.allProjects ? rows : rows.slice(0, 6);
  return `<div class="panel"><div class="panel-head"><h2 class="panel-title">Projects</h2><small>Selected period</small></div>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Project</th><th>Sessions</th><th>Tokens</th></tr></thead><tbody>${shown.map(([cwd, p]) => `<tr><td title="${esc(cwd || "")}">${esc(folder(cwd))}</td><td class="numeric">${full(p.sessions)}</td><td class="numeric">${num(p.tokens)}</td></tr>`).join("")}</tbody></table></div>${rows.length > 6 ? `<div class="table-note"><span>${shown.length} of ${rows.length} projects</span><button class="button" data-all-projects>${S.allProjects ? "Show fewer" : "Show all"}</button></div>` : ""}` : empty("No usage records", "Projects appear after an agent response.")}</div>`;
}
async function machines() {
  const main = $("#main");
  main.innerHTML =
    heading(
      "",
      "Machines",
      "Search configured machines through the existing SSH connection.",
      "",
    ) +
    '<div class="panel">' +
    empty("Checking machines", "Waiting for configured hosts to answer…") +
    "</div>";
  try {
    const d = await api("machines");
    if (S.page !== "machines") return;
    main.innerHTML =
      heading(
        "",
        "Machines",
        "Local analytics are collected here. Remote session search uses SSH.",
        "",
      ) +
      `<div class="panel"><div class="table-wrap"><table><thead><tr><th>Machine</th><th>Claude</th><th>Codex</th><th>Last used</th><th>Status</th></tr></thead><tbody>${d.machines.map((m) => `<tr><td>${esc(m.name)}</td><td>${m.claude ?? "—"}</td><td>${m.codex ?? "—"}</td><td>${esc(m.last || "—")}</td><td>${esc(m.status)}${m.error ? "<br>" + esc(m.error) : ""}</td></tr>`).join("")}</tbody></table></div></div>`;
  } catch (e) {
    toast(e.message);
  }
}
function settings() {
  return (
    heading(
      "",
      "Connections",
      "Manage the accounts connected to this workspace.",
      `<button class="button" data-accounts-refresh>↻ Refresh status</button>`,
    ) +
    `<div class="settings-grid">${(S.metrics?.profiles || [])
      .map((p) => {
        const a = S.accounts.find((a) => a.profile === p.id);
        return `<div class="panel connection-card" style="--accent:${colors[p.id] || colors.claude}"><span class="source-logo">${p.source === "codex" ? "◎" : "✳"}</span><h3>${esc(p.label)}</h3><p>${esc(p.path)}</p><div class="connection-state ${a?.connected ? "" : "off"}"><i class="online-dot" style="background:${a?.connected ? "#b4dec0" : "#ac9a73"}"></i> ${a ? (a.connected ? "Connected" + (a.plan ? " · " + esc(a.plan) : "") : "Not connected") : "Checking connection…"}</div><button class="button" data-login="${esc(p.id)}">${a?.connected ? "Sign in again" : "Sign in with " + (p.source === "codex" ? "ChatGPT" : "Claude")} ↗</button>${a?.error ? `<p class="error">${esc(a.error)}</p>` : ""}</div>`;
      })
      .join("")}</div>${phonePanel()}${uploadsPanel()}<div class="panel info-panel"><h3>A small service, on your machine.</h3>Collection continues when this tab is closed if the background service is installed. Metrics and workspace state are stored in <code>~/.context-find/dashboard</code>. Credentials stay in the installed tools.<p>Manage the collector with <code>cfind daemon status</code>, <code>cfind daemon start</code>, or <code>cfind daemon stop</code>. <code>cfind</code> on its own starts it.</p><p>Claude quota telemetry requires a terminal session with the collector status line. Restart existing Claude sessions after setup to load new hooks. Missing telemetry is shown as unavailable.</p></div>`
  );
}
function phonePanel() {
  const pair =
      S.pairing && S.pairing.expires > Date.now() ? S.pairing : null,
    link =
      pair?.url &&
      `cfind://pair?url=${encodeURIComponent(pair.url)}&code=${pair.code}`;
  return `<div class="panel phone-panel"><div class="phone-head"><div><h3>iPhone</h3><p>Read and reply from the cfind app on your iPhone. It reaches this Mac through Tailscale.</p></div>${pair ? "" : '<button class="button" data-pair>Pair an iPhone</button>'}</div>${
    pair
      ? `<div class="pair-box"><div class="pair-code">${esc(pair.code.slice(0, 3))} ${esc(pair.code.slice(3))}</div><p>${link ? `Copy the link, then tap <b>Paste pairing link</b> in the app. Or type the code.` : "Type this code in the app."} The code works once, until ${esc(clock(pair.expires))}.</p>${link ? `<div class="pair-link"><code>${esc(link)}</code><button class="button" data-copy-pair="${esc(link)}">Copy link</button></div>` : ""}</div>`
      : ""
  }${
    S.phones.host || pair?.url
      ? ""
      : `<p class="muted">Tailscale was not found on this Mac. Install it on this Mac and on the iPhone, sign in to the same account, then run <code>tailscale serve --bg 4319</code>.</p>`
  }${
    S.phones.devices.length
      ? `<div class="device-list">${S.phones.devices.map((d) => `<div class="device-row"><span>${esc(d.name)}</span><small>Paired ${esc(new Date(d.created).toLocaleDateString())} · Last seen ${esc(age(d.seen))}</small><button class="button" data-revoke-device="${esc(d.id)}">Revoke</button></div>`).join("")}</div>`
      : ""
  }</div>`;
}
function uploadsPanel() {
  const u = S.uploads;
  return `<div class="panel phone-panel"><div class="phone-head"><div><h3>Attached images</h3><p>Images you attach to a chat are kept for ${u?.keepDays ?? 7} days, then removed.${u ? ` ${full(u.count)} now, ${(u.bytes / 1048576).toFixed(1)} MB.` : ""}</p></div><button class="button" data-clear-uploads ${u?.count ? "" : "disabled"}>Clear now</button></div></div>`;
}
async function uploads() {
  try {
    S.uploads = await api("uploads");
    render();
  } catch (e) {
    toast(e.message);
  }
}
async function phones() {
  try {
    S.phones = await api("devices");
    render();
  } catch (e) {
    toast(e.message);
  }
}
function render() {
  if (!S.metrics || S.page === "machines") return;
  // A redraw would replace the select that an open list belongs to.
  if ($(".select-menu")) return;
  const f = document.activeElement;
  if (f && $("#main").contains(f) && ["INPUT", "TEXTAREA"].includes(f.tagName))
    return;
  const scroll = window.scrollY,
    main = $("#main"),
    board = $(".board", main),
    left = board?.scrollLeft,
    html =
    (S.metrics.errors.length
      ? `<div class="warning-banner">Collection warning: ${S.metrics.errors.map(esc).join(" · ")}</div>`
      : "") +
    ({ overview, workspace, sessions, settings }[S.page] || overview)();
  if (S.page === "workspace" && board) {
    const next = document.createElement("template");
    next.innerHTML = html;
    // Keep the scroll container connected while a trackpad gesture is active.
    board.innerHTML = $(".board", next.content).innerHTML;
    board.scrollLeft = left;
    $(".page-heading", main).replaceWith($(".page-heading", next.content));
    $(".warning-banner", main)?.remove();
    const warning = $(".warning-banner", next.content);
    if (warning) main.prepend(warning);
  } else main.innerHTML = html;
  window.scrollTo(0, scroll);
}
/** `fromHistory`: back or forward already chose the page and the chat. */
function navigate(page, fromHistory) {
  // A full-screen chat would hide the section, so it closes.
  if (S.view && S.chatFull && !fromHistory) closeDrawer();
  if (page !== "sessions") S.project = "all";
  if (!labels[page]) page = "overview";
  S.page = page;
  // pushState, not location.hash: a hash change would also send popstate, which
  // closes the chat. The step remembers a side-panel chat that stays open.
  if (location.hash !== "#" + page)
    history[fromHistory ? "replaceState" : "pushState"](
      S.view ? { chat: chatState() } : null,
      "",
      "#" + page,
    );
  $("#page-label").textContent = labels[page];
  $$(".nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.page === page),
  );
  if (page === "machines") void machines();
  else render();
  window.scrollTo(0, 0);
  if (page === "settings") {
    void accounts();
    void phones();
    void uploads();
  }
}
async function accounts() {
  try {
    const d = await api("accounts");
    S.accounts = d.accounts;
    render();
  } catch (e) {
    toast(e.message);
  }
}
function openNew() {
  const dialog = $("#new-dialog");
  $("#new-profile").innerHTML = (S.metrics?.profiles || [])
    .map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`)
    .join("");
  if (!$("#new-cwd").value)
    $("#new-cwd").value = S.metrics?.sessions.find((s) => s.cwd)?.cwd || "";
  $("#new-error").textContent = "";
  dialog.showModal();
}
const agentName = (profile) =>
  S.metrics?.profiles.find((p) => p.id === profile)?.source === "codex"
    ? "Codex"
    : "Claude";
const RUNNING = ["running", "waiting", "queued"],
  md = (text) => window.cfindMarkdown.markdown(text),
  clock = (t) =>
    new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function viewKey() {
  return !S.view
    ? ""
    : S.view.kind === "agent"
      ? "agent:" + S.view.id
      : "session:" + S.view.s.path;
}
// The Mac app skips banners for the chat on screen.
function tellApp() {
  window.webkit?.messageHandlers?.cfind?.postMessage(viewKey());
}
function viewAgent() {
  return S.view?.kind === "agent"
    ? S.workspace.agents.find((a) => a.id === S.view.id)
    : null;
}
/** Each chat opened or closed is a step that back and forward walk through,
 *  also with the mouse's side buttons. */
function chatState() {
  const v = S.view;
  return v.kind === "agent"
    ? { key: viewKey(), kind: "agent", id: v.id }
    : { key: viewKey(), kind: "session", path: v.s.path, host: v.s.host || "" };
}
let restoring = false;
window.addEventListener("popstate", (e) => {
  const c = e.state?.chat;
  if (c?.key === viewKey()) return;
  restoring = true;
  try {
    if (c?.kind === "session")
      openSession({ path: c.path, host: c.host || undefined });
    else if (c && S.workspace.agents.some((a) => a.id === c.id))
      openView({ kind: "agent", id: c.id });
    else if (S.view) closeDrawer();
  } finally {
    restoring = false;
  }
});
/** Closing by hand is a step, so back opens the chat again. */
function leaveChat() {
  closeDrawer();
  history.pushState(null, "");
}
function closeDrawer() {
  S.view = null;
  S.chat = null;
  watchChat();
  tellApp();
  $("#drawer").hidden = true;
  $("#drawer").innerHTML = "";
}
function openAgent(id, owned, profile) {
  if (owned) openView({ kind: "agent", id });
  else {
    const s = S.metrics?.sessions.find(
      (s) => s.id === id && s.profile === profile,
    );
    if (s) openSession(s);
  }
}
function openSession(row) {
  // Search rows carry only the path and source; the collector knows the rest.
  const s = row.host
    ? row
    : {
        ...row,
        ...(S.metrics?.sessions.find((x) => x.path === row.path) || {}),
      };
  const a = S.workspace.agents.find(
    (a) => a.profile === s.profile && (a.history === s.path || a.sid === s.id),
  );
  if (a) openView({ kind: "agent", id: a.id });
  else openView({ kind: "session", s });
}
// The Mac app opens a chat this way when a notification is clicked.
window.cfindOpen = (kind, id) =>
  kind === "agent" ? openView({ kind: "agent", id }) : openSession({ path: id });
function openView(view) {
  S.view = view;
  S.chat = { key: viewKey(), history: [], omitted: 0, loading: true };
  if (restoring) history.replaceState({ chat: chatState() }, "");
  else if (history.state?.chat?.key !== S.chat.key)
    history.pushState({ chat: chatState() }, "");
  tellApp();
  // Each chat opens at the saved size.
  S.chatFull = localStorage.getItem("cfind-chat-size") !== "panel";
  const drawer = $("#drawer");
  drawer.hidden = false;
  drawer.classList.toggle("full", S.chatFull);
  drawer.innerHTML = `<div class="drawer-head"><div class="chat-heading"><h2 id="chat-title"></h2><small id="chat-meta"></small></div><div class="drawer-actions" id="chat-actions"></div></div><div class="reader-find" id="chat-find" hidden><input id="reader-q" placeholder="Find in conversation…" aria-label="Find in conversation" autocomplete="off"></div><div class="conversation chat" id="chat-list"></div><div id="chat-pending"></div><form id="agent-form" class="composer"><div class="composer-box"><div class="slash-menu" id="slash-menu" role="listbox" aria-label="Commands" hidden></div><div class="composer-images" id="composer-images" hidden></div><textarea id="agent-prompt" rows="1" aria-label="Message"></textarea><div class="composer-tools"><button type="button" class="round-button attach" data-attach aria-label="Attach images" title="Attach images">${icon('<path d="M12 5v14M5 12h14"/>')}</button><input type="file" id="image-input" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden><button type="button" class="mode-button" data-mode hidden></button><span id="composer-buttons"></span></div></div><div class="composer-footer"><span id="composer-hint"></span></div></form>`;
  $("#agent-prompt").value = S.drafts[S.chat.key] || "";
  grow($("#agent-prompt"));
  renderAttachments();
  renderChat();
  if (!watchChat()) void loadHistory();
  void connectCodex();
}
async function connectCodex() {
  const chat = S.chat, a = viewAgent(), s = S.view?.kind === "session" ? S.view.s : null;
  const profile = a?.profile || s?.profile;
  const source = S.metrics?.profiles.find(p => p.id === profile)?.source;
  const sid = a?.sid || s?.id;
  if (source !== "codex" || !sid || s?.host || s?.parent) return;
  chat.connecting = true;
  renderChat();
  try {
    const connected = await api("agent", { action: "attach", profile, sid });
    if (S.chat !== chat) return;
    const existing = S.workspace.agents.find(x => x.id === connected.id);
    if (!existing) S.workspace.agents.unshift(connected);
    S.view = { kind: "agent", id: connected.id };
    chat.key = viewKey();
    chat.connectError = "";
    tellApp();
    watchChat();
  } catch (error) {
    if (S.chat !== chat) return;
    chat.connectError = error.message;
  } finally {
    if (S.chat === chat) { chat.connecting = false; renderChat(); }
  }
}
/** A local transcript pushes its new messages while its chat is open. Returns
 *  false for chats that load another way (remote sessions, dashboard agents). */
function watchChat() {
  S.chatStream?.close();
  S.chatStream = null;
  const chat = S.chat,
    s = S.view?.kind === "session" ? S.view.s : null;
  if (!chat || !s || s.host) return false;
  const es = new EventSource(
    "/api/chat-events?t=" +
      encodeURIComponent(T) +
      "&path=" +
      encodeURIComponent(s.path),
  );
  // The first event and each reconnect send the whole chat; later ones only the
  // new or changed messages, merged by id.
  es.addEventListener("chat", (e) => {
    const d = JSON.parse(e.data);
    chat.history = d.messages;
    chat.omitted = d.omitted;
    chat.loading = false;
    chat.error = "";
    if (S.chat === chat) renderChat();
  });
  es.addEventListener("chat-delta", (e) => {
    const d = JSON.parse(e.data),
      byId = new Map(chat.history.map((m) => [m.id, m]));
    for (const m of d.messages) byId.set(m.id, m);
    chat.history = [...byId.values()].slice(-400);
    chat.omitted = d.omitted;
    if (S.chat === chat) renderChat();
  });
  // A refused stream does not retry; the plain request shows why.
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED && S.chatStream === es)
      void loadHistory();
  };
  S.chatStream = es;
  return true;
}
function grow(t) {
  // The auto height below lets the chat scroll for a moment; without this the
  // chat jumped up and down on every key.
  const list = $("#chat-list"),
    fromBottom = list && list.scrollHeight - list.scrollTop - list.clientHeight;
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 220) + "px";
  // Sub-pixel line heights round up; only scroll once the box reaches its limit.
  t.style.overflowY = t.scrollHeight > 220 ? "auto" : "hidden";
  if (list) list.scrollTop = list.scrollHeight - list.clientHeight - fromBottom;
}
async function loadHistory() {
  const chat = S.chat,
    a = viewAgent(),
    s = S.view?.kind === "session" ? S.view.s : null,
    path = a ? a.history : s?.path;
  try {
    if (s?.host) {
      const d = await api(
        "session?path=" +
          encodeURIComponent(s.path) +
          "&host=" +
          encodeURIComponent(s.host),
      );
      chat.lines = d.lines;
    } else if (path) {
      const d = await api("conversation?path=" + encodeURIComponent(path));
      chat.history = d.messages;
      chat.omitted = d.omitted;
    }
    chat.error = "";
  } catch (e) {
    chat.error = e.message;
  }
  chat.loading = false;
  chat.loadedAt = s?.updatedAt;
  chat.fetchedAt = Date.now();
  if (S.chat === chat) renderChat();
}
/** External sessions keep writing to their transcript; follow them while open. */
function followSession() {
  if (S.view?.kind !== "session" || S.view.s.host || !S.chat) return;
  const s = S.metrics?.sessions.find((x) => x.path === S.view.s.path);
  if (!s) return;
  S.view.s = { ...S.view.s, ...s };
  // Each reload reads the whole transcript, so a busy session reloads at most every 3s.
  if (!S.chatStream && s.updatedAt !== S.chat.loadedAt && !S.chat.loading) {
    const chat = S.chat;
    chat.loading = true;
    setTimeout(
      () => S.chat === chat && void loadHistory(),
      Math.max(400, 3000 - (Date.now() - (chat.fetchedAt || 0))),
    );
  }
  renderChat();
}
function chatItems(a, s) {
  const items = [],
    label = profileLabel(a ? a.profile : s.profile || s.source),
    chat = S.chat;
  S.chatText = new Map();
  if (chat.omitted)
    items.push({
      key: "omitted",
      html: `<div class="chat-note">${full(chat.omitted)} earlier messages are not shown</div>`,
    });
  if (chat.lines)
    items.push({
      key: "lines",
      html: `<div class="reader-lines">${chat.lines.map(([style, line]) => `<div class="reader-line ${esc(style)}">${esc(line) || " "}</div>`).join("")}</div>`,
    });
  const history = a && !a.external
    ? chat.history.filter((m) => !m.time || m.time < a.startedAt)
    : chat.history;
  for (const m of history) items.push(messageItem("h:" + m.id, m, label));
  if (a && !a.external && history.length)
    items.push({
      key: "continued",
      html: `<div class="chat-note">Continued in the dashboard · ${esc(clock(a.startedAt))}</div>`,
    });
  for (const m of (a?.messages || []).filter(m => !a.external || m.role === "note"))
    items.push(messageItem("m:" + m.id, m, label));
  // Shown from the moment the agent starts, before its first words or tool call.
  if (a ? ["running", "queued"].includes(a.state) : s.state === "running") {
    const asked = [...(a ? a.messages : chat.history)]
      .reverse()
      .find((m) => m.role === "user" && m.time)?.time;
    items.push({
      key: "typing",
      html: `<div class="msg agent"><div class="bubble typing" aria-label="${esc(label)} is working"><i></i><i></i><i></i></div><div class="msg-meta"><span data-since="${asked || Date.now()}">Working</span></div></div>`,
    });
  }
  (a?.queue || []).forEach((q, i) =>
    items.push({
      key: `q:${i}:${q.text.length}:${q.images?.length || 0}`,
      html: `<div class="msg user queued">${imagesHtml(q.images)}${q.text ? `<div class="bubble">${md(q.text)}</div>` : ""}<div class="msg-meta"><span>Queued</span>${RUNNING.includes(a.state) ? '<button type="button" class="link-button" data-send-now>Send now</button>' : ""}<button type="button" class="link-button" data-unqueue="${i}">Remove</button></div></div>`,
    }),
  );
  for (const p of outbox(a))
    items.push({
      key: "p:" + p.id,
      html: `<div class="msg user${p.dashed ? " queued" : ""}">${imagesHtml(p.images)}${p.text ? `<div class="bubble">${md(p.text)}</div>` : ""}<div class="msg-meta">${p.note ? `<span>${esc(p.note)}</span>` : `<span>You</span><time>${esc(clock(p.at))}</time>`}${p.sendNow ? '<button type="button" class="link-button" data-send-now>Send now</button>' : ""}</div></div>`,
    });
  if (a?.error)
    items.push({
      key: "error",
      html: `<div class="chat-note error">${esc(a.error)}</div>`,
    });
  if (chat.error)
    items.push({
      key: "load-error",
      html: `<div class="chat-note error">${esc(chat.error)}</div>`,
    });
  if (chat.loading && !items.length)
    items.push({
      key: "loading",
      html: `<div class="chat-note">Opening conversation…</div>`,
    });
  if (!chat.loading && !items.length)
    items.push({
      key: "empty",
      html: `<div class="chat-note">No messages yet</div>`,
    });
  return items;
}
/** A sent message shows at once. It goes when the chat has it: the agent's
 *  messages or queue, or the transcript for a message typed into a terminal. */
function outbox(a) {
  const list = S.outbox[S.chat.key];
  if (!list?.length) return [];
  const seen = a
      ? [...a.messages, ...a.queue.map((q) => ({ role: "user", text: q.text }))]
      : S.chat.history,
    flat = (t) => (t || "").replace(/\s+/g, " ").trim();
  return (S.outbox[S.chat.key] = list.filter((p) => {
    // A ! command shows as its command, in a Shell row or <bash-input>.
    // A /command typed into a terminal is logged as a note: "/effort: Set effort…".
    const want = flat(p.text.replace(/^!/, ""));
    return (
      Date.now() - p.at < 30 * 60 * 1000 &&
      !seen.some(
        (m) =>
          (m.role === "user" ||
            m.role === "tool" ||
            (m.role === "note" && want.startsWith("/"))) &&
          !(m.time < p.at - 5000) &&
          flat(m.text).includes(want),
      )
    );
  }));
}
// Markdown is most of a render's cost. Live updates replace a changed message
// with a new object, so an unchanged one keeps its HTML.
const rendered = new WeakMap();
function messageItem(key, m, label) {
  if (m.role !== "tool" && m.role !== "note") S.chatText.set(key, m.text);
  const hit = rendered.get(m);
  if (hit?.key === key && hit.label === label) return hit.item;
  const item = messageHtml(key, m, label);
  rendered.set(m, { key, label, item });
  return item;
}
function messageHtml(key, m, label) {
  if (m.role === "tool") return { key, html: toolHtml(m) };
  if (m.role === "note")
    return { key, html: `<div class="chat-note">${esc(m.text)}</div>` };
  const user = m.role === "user";
  return {
    key,
    html: `<div class="msg ${user ? "user" : "agent"}">${imagesHtml(m.images)}${m.text ? `<div class="bubble">${md(m.text)}</div>` : ""}<div class="msg-meta"><span>${user ? "You" : esc(label)}</span>${m.time ? `<time>${esc(clock(m.time))}</time>` : ""}${m.text ? '<button type="button" class="link-button" data-copy-msg>Copy</button>' : ""}</div></div>`,
  };
}
// Transcripts carry images as data URLs, dashboard messages as upload ids. Both
// patterns allow only characters that are safe inside an attribute.
const IMAGE_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/,
  UPLOAD_ID = /^[0-9a-f]{32}\.(png|jpg|gif|webp)$/;
function imagesHtml(list) {
  const urls = (list || [])
    .map((v) =>
      IMAGE_URL.test(v)
        ? v
        : UPLOAD_ID.test(v)
          ? `/api/upload?t=${encodeURIComponent(T)}&id=${v}`
          : "",
    )
    .filter(Boolean);
  return urls.length
    ? `<div class="msg-images">${urls.map((u) => `<img src="${u}" alt="Attached image" loading="lazy" data-view-image>`).join("")}</div>`
    : "";
}
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
async function attach(files) {
  const list = (S.images[S.chat.key] ||= []);
  for (const f of files) {
    if (!IMAGE_TYPES.includes(f.type)) {
      toast("Only PNG, JPEG, GIF and WebP images are supported");
      continue;
    }
    if (list.length >= 4) {
      toast("Attach up to 4 images");
      break;
    }
    if (f.size > 10 * 1024 * 1024) {
      toast("Images must be 10 MB or smaller");
      continue;
    }
    const item = { url: URL.createObjectURL(f) };
    list.push(item);
    renderAttachments();
    try {
      const r = await fetch("/api/upload?t=" + encodeURIComponent(T), {
          method: "POST",
          headers: { "content-type": f.type },
          body: f,
        }),
        data = await r.json();
      if (!r.ok || data.error)
        throw new Error(data.error || `Upload failed (${r.status})`);
      item.id = data.id;
    } catch (e) {
      if (list.includes(item)) list.splice(list.indexOf(item), 1);
      URL.revokeObjectURL(item.url);
      toast(e.message);
    }
    renderAttachments();
  }
}
function renderAttachments() {
  const box = $("#composer-images");
  if (!box || !S.chat) return;
  const list = S.images[S.chat.key] || [];
  box.hidden = !list.length;
  if ($("#composer-hint")) shellMode();
  box.innerHTML = list
    .map(
      (im, i) =>
        `<div class="attachment${im.id ? "" : " uploading"}"><img src="${esc(im.url)}" alt="Image to send"><button type="button" class="attachment-remove" data-remove-image="${i}" aria-label="Remove image">×</button></div>`,
    )
    .join("");
}
function codeBlock(label, text) {
  return `<div class="md-code"><div class="md-code-head"><span>${esc(label)}</span><button type="button" class="md-copy" data-copy-code>Copy</button></div><pre><code>${esc(text)}</code></pre></div>`;
}
function toolHtml(m) {
  const t = m.tool || { name: "Tool", input: m.text },
    status = t.output === undefined ? "" : t.error ? "Failed" : "Done";
  return `<details class="tool-call ${t.error ? "failed" : ""}"><summary>${icon('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m7.5 10 2.5 2-2.5 2m5 0h4"/>')}<span class="tool-name">${esc(t.name)}</span><span class="tool-arg">${esc(m.text)}</span>${status ? `<span class="tool-state">${status}</span>` : ""}</summary><div class="tool-body">${codeBlock("Input", t.input)}${t.output !== undefined ? codeBlock(t.error ? "Error" : "Output", t.output || "(no output)") : ""}</div></details>`;
}
function patch(list, items) {
  const old = new Map([...list.children].map((el) => [el.dataset.key, el]));
  let prev = null;
  for (const it of items) {
    let el = old.get(it.key);
    old.delete(it.key);
    if (!el || el._html !== it.html) {
      const t = document.createElement("template");
      t.innerHTML = it.html.trim();
      const next = t.content.firstElementChild;
      next.dataset.key = it.key;
      next._html = it.html;
      if (el) {
        if (el.open) next.open = true;
        el.replaceWith(next);
      }
      el = next;
    }
    const want = prev ? prev.nextElementSibling : list.firstElementChild;
    if (want !== el) list.insertBefore(el, want);
    prev = el;
  }
  for (const el of old.values()) el.remove();
}
function questionsOf(p) {
  const params = p.params || {};
  if (p.method === "item/tool/requestUserInput")
    return (params.questions || []).map((q) => ({
      key: q.id,
      header: q.header,
      question: q.question,
      options: q.options || [],
      other: q.isOther || !q.options?.length,
      secret: q.isSecret,
    }));
  if (params.tool_name === "AskUserQuestion")
    return (params.input?.questions || []).map((q) => ({
      key: q.question,
      header: q.header,
      question: q.question,
      options: q.options || [],
      multi: !!q.multiSelect,
      other: true,
    }));
  return null;
}
function pendingHtml(a) {
  const p = a.pending,
    params = p.params || {},
    label = agentName(a.profile),
    questions = questionsOf(p);
  if (questions)
    return `<div class="ask-card" data-pending="${esc(p.id)}"><div class="ask-title">${icon('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.3a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.3-2.5 3.8M12 17h.01"/>')}<span>${esc(label)} is asking</span></div>${questions
      .map(
        (q, qi) =>
          `<div class="ask-question" data-question="${qi}" data-key="${esc(q.key)}" ${q.multi ? "data-multi" : ""}>${q.header ? `<div class="ask-header">${esc(q.header)}</div>` : ""}<p>${esc(q.question)}</p><div class="ask-options">${q.options.map((o) => `<button type="button" class="ask-option" data-option aria-pressed="false" data-label="${esc(o.label)}"><b>${esc(o.label)}</b>${o.description && o.description !== o.label ? `<small>${esc(o.description)}</small>` : ""}</button>`).join("")}</div>${q.other ? `<input class="ask-other" data-other ${q.secret ? 'type="password"' : ""} placeholder="${q.options.length ? "Or type your own answer" : "Type your answer"}" autocomplete="off">` : ""}</div>`,
      )
      .join(
        "",
      )}<div class="ask-actions"><button type="button" class="button" data-respond="deny">Skip</button><button type="button" class="button light" data-respond="answer" disabled>Send answer</button></div></div>`;
  const claude = p.method === "can_use_tool",
    input = params.input || {},
    tool = claude ? params.display_name || params.tool_name : "",
    change = a.messages.find((m) => m.id === params.itemId)?.tool,
    preview = claude
      ? input.command
        ? codeBlock("Command", input.command)
        : input.file_path
          ? codeBlock(
              input.file_path,
              input.content ??
                [
                  input.old_string && "- " + input.old_string,
                  input.new_string && "+ " + input.new_string,
                ]
                  .filter(Boolean)
                  .join("\n") ??
                "",
            )
          : codeBlock("Input", JSON.stringify(input, null, 2))
      : params.command
        ? codeBlock(
            params.cwd ? "Command · " + folder(params.cwd) : "Command",
            params.command,
          )
        : change
          ? codeBlock("Changes", change.input)
          : codeBlock(
              "Request",
              JSON.stringify(
                params.permissions || params.requestedSchema || params,
                null,
                2,
              ),
            ),
    always = claude
      ? (params.permission_suggestions || []).some(
          (s) => s.destination === "session",
        ) &&
        ((params.permission_suggestions || []).some(
          (s) => s.mode === "acceptEdits",
        )
          ? "Allow edits this session"
          : "Allow this session")
      : [
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
        ].includes(p.method) && "Allow this session",
    title = claude
      ? `Allow ${tool}?`
      : p.method === "item/fileChange/requestApproval"
        ? "Allow these file changes?"
        : p.method === "item/commandExecution/requestApproval"
          ? "Allow this command?"
          : p.method === "mcpServer/elicitation/request"
            ? esc(params.message || "A tool needs your input")
            : "Allow this request?";
  return `<div class="ask-card permission" data-pending="${esc(p.id)}"><div class="ask-title">${icon('<path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6l-7-3Z"/>')}<span>${claude ? esc(title) : title}</span></div>${params.description || params.reason ? `<p class="ask-reason">${esc(params.description || params.reason)}</p>` : ""}${preview}<div class="ask-actions"><button type="button" class="button" data-respond="deny">Decline</button>${always ? `<button type="button" class="button" data-respond="always">${esc(always)}</button>` : ""}<button type="button" class="button light" data-respond="allow">Allow once</button></div>${claude ? `<p class="ask-hint">Or write a reply below to decline and tell ${esc(label)} what to do instead.</p>` : ""}</div>`;
}
function readyAnswers() {
  const card = $(".ask-card[data-pending]");
  if (!card) return null;
  const answers = {};
  for (const q of $$(".ask-question", card)) {
    const picked = $$(".ask-option.selected", q).map((o) => o.dataset.label),
      other = $("[data-other]", q)?.value.trim();
    if (other) picked.push(other);
    if (!picked.length) return null;
    answers[q.dataset.key] = picked;
  }
  return answers;
}
function composerState(a, s) {
  const label = a ? agentName(a.profile) : profileLabel(s.profile || s.source);
  if (S.chat?.connecting || S.chat?.connectError)
    return { enabled: false, placeholder: S.chat.connecting ? "Connecting to Codex…" : "Codex connection unavailable", hint: S.chat.connectError || "Connecting to this session's controls" };
  if (a) {
    const decline =
      a.pending?.method === "can_use_tool" &&
      a.pending.params?.tool_name !== "AskUserQuestion";
    return {
      enabled: true,
      placeholder: decline
        ? `Decline and tell ${label} what to do instead…`
        : a.state === "running"
          ? "Queue a follow-up…"
          : `Message ${label}…`,
      hint:
        a.state === "running"
          ? "Messages wait in the queue until the current reply ends."
          : `${folder(a.cwd)} · Enter to send, Shift Enter for a new line`,
      stop: RUNNING.includes(a.state),
    };
  }
  if (opening(s))
    return {
      enabled: false,
      placeholder: "Starting in a terminal…",
      hint: "Answer any question in the terminal view above",
    };
  const idle = s.state === "idle",
    local = !s.host && !s.parent;
  // The server checks who has the file open: the Codex helper, another window, or nobody.
  if (local && s.source === "codex" && s.profile)
    return ["running", "waiting"].includes(s.state)
      ? {
          enabled: true,
          placeholder: `Queue a message for ${label}…`,
          hint: "Runs after the current reply · Enter to send",
        }
      : {
          enabled: true,
          placeholder: "Continue this conversation…",
          hint: `Sends to ${label} if it is open, or continues here · Enter to send`,
        };
  if (local && s.open && s.tmux && (idle || s.state === "running"))
    return {
      enabled: true,
      live: true,
      stop: s.state === "running",
      placeholder: idle
        ? `Message ${label} in its terminal…`
        : `Message ${label} while it works…`,
      hint: idle
        ? "Types into its tmux pane · Enter to send"
        : "Claude reads this before it finishes · Enter to send",
    };
  const reason = s.host
    ? "Remote sessions are read-only here. Resume them from the terminal."
    : s.parent
      ? "Subagent transcripts are read-only."
      : s.open && s.tmux
        ? s.state === "waiting"
          ? "Answer in the terminal view above, with its buttons or your keyboard."
          : "Its state is unclear. Open the terminal view to see it."
        : s.open && idle
          ? "Open in a terminal outside tmux. Reply there, or take over to continue here."
          : s.open || ["running", "waiting", "stale"].includes(s.state)
            ? "Open in another window. Reply there, or quit it there (/exit) to continue here."
            : !s.profile
              ? "Open this session from the Sessions list to continue it."
              : "";
  return reason
    ? {
        enabled: false,
        placeholder: "Read only",
        hint: reason,
        takeover: local && s.open && !s.tmux && idle,
      }
    : {
        enabled: true,
        placeholder: "Continue this conversation…",
        hint: `Continues with ${label} in ${folder(s.cwd)} · Enter to send`,
      };
}
function renderChat() {
  if (!S.view || !S.chat) return;
  const a = viewAgent(),
    s = S.view.kind === "session" ? S.view.s : null;
  if (S.view.kind === "agent" && !a) return closeDrawer();
  const drawer = $("#drawer"),
    list = $("#chat-list"),
    state0 = shownState(a || { ...s, state: s.state || "idle" }),
    label = profileLabel(a ? a.profile : s.profile || s.source);
  $("#chat-title").textContent =
    (a ? a.title : s.title || s.summary) || "Conversation";
  $("#chat-meta").innerHTML =
    `<i class="state-dot ${esc(state0)}"></i> ${esc(state(state0))} · ${esc(label)} · ${esc(folder(a ? a.cwd : s.cwd))}${a?.model ? " · " + esc(a.model) : ""}`;
  const c = composerState(a, s),
    confirm = S.confirmTakeover === S.chat.key,
    term = !!s && termShown(s);
  const actions = `<button class="icon-button" data-find aria-label="Find in conversation" title="Find">${icon('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>')}</button>${s && inTmux(s) ? `<button class="icon-button" data-term aria-pressed="${term}" aria-label="Terminal view" title="Terminal view">${icon('<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="m7.5 9.5 2.5 2.5-2.5 2.5M12.5 14.5h4"/>')}</button>` : ""}${a && a.sid && !a.external && agentName(a.profile) === "Claude" && !RUNNING.includes(a.state) ? '<button class="button" data-open-terminal title="Continue this chat in a tmux window. Its terminal shows here.">Open in terminal</button>' : ""}${a && !RUNNING.includes(a.state) ? '<button class="button" data-dismiss>Remove card</button>' : ""}${c.takeover ? `<button class="button${confirm ? " light" : ""}" data-takeover>${confirm ? "Stop it in the terminal?" : "Take over"}</button>` : ""}<button class="icon-button" data-chat-size aria-label="${S.chatFull ? "Show as side panel" : "Show full screen"}" title="${S.chatFull ? "Side panel" : "Full screen"}">${icon(S.chatFull ? '<path d="M4 14h6v6m10-10h-6V4m0 6 7-7M3 21l7-7"/>' : '<path d="M14 4h6v6M10 20H4v-6m16-10-7 7M4 20l7-7"/>')}</button><button class="icon-button" data-close-drawer aria-label="Close conversation">×</button>`;
  if ($("#chat-actions")._html !== actions) {
    $("#chat-actions").innerHTML = actions;
    $("#chat-actions")._html = actions;
  }
  const near =
      list.scrollHeight - list.scrollTop - list.clientHeight < 120 ||
      !list.children.length,
    items = chatItems(a, s);
  patch(list, items);
  tickWorking();
  markFind();
  if (near && !$("#reader-q").value) list.scrollTop = list.scrollHeight;
  const pending = $("#chat-pending"),
    pendingKey = a?.pending ? String(a.pending.id) : term ? "term" : "";
  if (pending.dataset.key !== pendingKey) {
    pending.dataset.key = pendingKey;
    pending.innerHTML = a?.pending ? pendingHtml(a) : term ? termHtml() : "";
    if (term) pollTerm();
  }
  const t = $("#agent-prompt");
  t.disabled = !c.enabled;
  t.placeholder = c.placeholder;
  const hint = $("#composer-hint"),
    mode = $("[data-mode]"),
    auto = a?.permissionMode === "auto";
  hint.dataset.hint = c.hint;
  hint.dataset.shell = !c.enabled
    ? ""
    : a
      ? `Runs in ${folder(a.cwd)} · ${agentName(a.profile)} sees the output with your next message`
      : c.live
        ? "Its terminal runs this as a command"
        : "";
  shellMode();
  mode.hidden = !a || !c.enabled;
  mode.textContent = auto ? "Auto" : "Ask first";
  mode.classList.toggle("on", auto);
  mode.title = `${auto ? "Runs commands without asking" : "Asks before each command"} · Shift+Tab to switch`;
  $("[data-attach]").hidden = !c.enabled;
  const buttons = `${c.stop ? `<button type="button" class="round-button stop" data-cancel aria-label="Stop" title="Stop">${icon('<rect x="7" y="7" width="10" height="10" rx="2"/>')}</button>` : ""}${c.enabled ? `<button type="submit" class="round-button send" aria-label="Send" title="Send">${icon('<path d="M12 19V5m-6 6 6-6 6 6"/>')}</button>` : ""}`;
  if ($("#composer-buttons")._html !== buttons) {
    $("#composer-buttons").innerHTML = buttons;
    $("#composer-buttons")._html = buttons;
  }
  drawer.classList.toggle("read-only", !c.enabled);
}
/** A message that starts with ! runs as a command in the agent's folder. */
function shellMode() {
  const hint = $("#composer-hint"),
    t = $("#agent-prompt"),
    on = !!hint.dataset.shell && t.value.startsWith("!");
  $("#agent-form").classList.toggle("bang-mode", on);
  $("#agent-form").classList.toggle(
    "no-text",
    !t.value.trim() && !S.images[S.chat.key]?.length,
  );
  hint.textContent = on ? hint.dataset.shell : hint.dataset.hint;
}
/** Seconds since the agent was asked, as its terminal counts them. */
function tickWorking() {
  for (const el of document.querySelectorAll("[data-since]")) {
    const s = Math.max(0, Math.round((Date.now() - el.dataset.since) / 1000));
    el.textContent =
      "Working · " +
      (s < 60
        ? s + "s"
        : s < 3600
          ? `${Math.floor(s / 60)}m ${s % 60}s`
          : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`);
  }
}
setInterval(tickWorking, 1000);
/** Shift+Tab, as in the terminal: switches between Auto and Ask first. */
function switchMode() {
  const a = viewAgent();
  if (a) {
    api("agent", {
      action: "mode",
      id: a.id,
      mode: a.permissionMode === "auto" ? "manual" : "auto",
    }).catch((e) => toast(e.message));
    return true;
  }
  if (S.view?.kind === "session" && composerState(null, S.view.s).live) {
    sendTermKey("BTab");
    toast("Switched mode in its terminal");
    return true;
  }
  return false;
}
const inTmux = (s) => !s.host && !s.parent && s.open && s.tmux;
/** A tmux session shows its pane while a terminal menu waits, or when asked.
 *  Hiding it lasts until the session's state changes. */
function termShown(s) {
  const t = S.term;
  if (!inTmux(s)) return opening(s) && (t?.key !== S.chat.key || t.show);
  return t?.key === S.chat.key && t.state === s.state
    ? t.show
    : s.state === "waiting";
}
/** A chat just moved to tmux shows its pane before Claude records the session;
 *  Claude waits for a folder trust answer before it does. */
function opening(s) {
  const o = S.opening;
  if (o?.path !== s.path) return false;
  if (inTmux(s) || Date.now() > o.until) {
    S.opening = null;
    // Keep the pane on screen once the session is live.
    if (S.term?.key === S.chat.key) S.term.state = s.state;
  }
  return !!S.opening;
}
/** Moves a Claude agent into a tmux window; the chat follows it there. */
async function openTerminal() {
  const a = viewAgent();
  if (!a) return;
  const t = await api("agent", { action: "terminal", id: a.id }),
    s = S.metrics?.sessions.find(
      (x) => x.profile === t.profile && x.id === t.sid,
    );
  S.workspace.agents = S.workspace.agents.filter((x) => x.id !== a.id);
  if (!s) {
    closeDrawer();
    return toast("Opened in the tmux session cfind");
  }
  S.opening = { path: s.path, until: Date.now() + 2 * 60 * 1000 };
  openSession(s);
  S.term = { key: S.chat.key, state: S.view.s.state, show: true };
  renderChat();
}
function termHtml() {
  const keys = [
    ["Up", "↑"],
    ["Down", "↓"],
    ["Left", "←"],
    ["Right", "→"],
    ["Tab", "Tab"],
    ["Escape", "Esc"],
  ];
  return `<div class="term-card" tabindex="0" aria-label="Terminal view. Keys you press here go to the terminal."><div class="term-head"><span>Terminal</span><small id="term-status">Click here to use your keyboard</small><button type="button" class="icon-button" data-term aria-label="Hide terminal view">×</button></div><pre class="term-screen" id="term-screen"></pre><div class="term-keys">${keys.map(([k, label]) => `<button type="button" class="button" data-term-key="${k}">${label}</button>`).join("")}<button type="button" class="button light" data-term-key="Enter">Enter</button></div></div>`;
}
/** Reads the pane every second while the card is on screen. Only the newest
 *  call goes on, so a key press does not start a second loop. */
async function pollTerm() {
  clearTimeout(S.termTimer);
  const run = (S.termRun = (S.termRun || 0) + 1),
    s = S.view?.kind === "session" ? S.view.s : null,
    screen = $("#term-screen");
  if (!s || !screen) return;
  try {
    const d = await api(
      `live-screen?profile=${encodeURIComponent(s.profile)}&sid=${encodeURIComponent(s.id)}`,
    );
    if (run !== S.termRun || !screen.isConnected) return;
    $("#term-status").textContent = "Click here to use your keyboard";
    if (screen.textContent !== d.screen) {
      // Text, never HTML: the pane shows whatever the session printed.
      screen.textContent = d.screen;
      screen.scrollTop = screen.scrollHeight;
    }
  } catch (error) {
    if (run !== S.termRun || !screen.isConnected) return;
    $("#term-status").textContent = error.message;
  }
  S.termTimer = setTimeout(pollTerm, document.hidden ? 5000 : 1000);
}
async function sendTermKey(key) {
  const s = S.view?.s;
  if (!s) return;
  try {
    await api("agent", {
      action: "live-key",
      profile: s.profile,
      sid: s.id,
      key,
    });
    setTimeout(pollTerm, 120);
  } catch (error) {
    toast(error.message);
  }
}
const TERM_KEYS = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Enter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  " ": "Space",
};
/** Keys pressed while the card has focus go to the terminal. */
function termKeyDown(e) {
  if (!e.target.closest?.(".term-card") || e.metaKey || e.ctrlKey || e.altKey)
    return false;
  const key =
    e.key === "Tab" && e.shiftKey
      ? "BTab"
      : /^[1-9a-z]$/.test(e.key)
        ? e.key
        : TERM_KEYS[e.key];
  if (!key) return false;
  e.preventDefault();
  sendTermKey(key);
  return true;
}
function markFind() {
  const q = $("#reader-q")?.value.trim().toLowerCase();
  let first = null;
  for (const el of $("#chat-list")?.children || []) {
    const hit = !!q && el.textContent.toLowerCase().includes(q);
    el.classList.toggle("hit", hit);
    if (hit && !first) first = el;
  }
  return first;
}
async function sendFromComposer() {
  const t = $("#agent-prompt"),
    prompt = t.value.trim(),
    key = S.chat.key,
    list = S.images[key] || [],
    images = list.map((im) => im.id);
  if ((!prompt && !list.length) || t.disabled) return;
  if (!images.every(Boolean)) return toast("Wait for the images to upload");
  const a = viewAgent(),
    decline =
      !prompt.startsWith("!") &&
      a?.pending?.method === "can_use_tool" &&
      a.pending.params?.tool_name !== "AskUserQuestion";
  if (decline && images.length)
    return toast("Answer the request first, then send images");
  t.value = "";
  grow(t);
  shellMode();
  delete S.drafts[key];
  delete S.images[key];
  renderAttachments();
  // Shown before the server answers. Dashed when it waits: in a busy agent's
  // queue, or in a terminal until Claude reads it.
  const live = !a && composerState(null, S.view.s).live,
    sent = {
      id: Math.random().toString(36).slice(2),
      text: prompt,
      images,
      at: Date.now(),
      dashed:
        live ||
        (!!a && !decline && !prompt.startsWith("!") && RUNNING.includes(a.state)),
    };
  sent.note = sent.dashed ? (live ? "Sending…" : "Queued") : "";
  (S.outbox[key] ||= []).push(sent);
  const drop = () =>
    (S.outbox[key] = (S.outbox[key] || []).filter((p) => p !== sent));
  renderChat();
  $("#chat-list").scrollTop = $("#chat-list").scrollHeight;
  try {
    if (a) {
      if (decline)
        await api("agent", {
          action: "respond",
          id: a.id,
          answer: { allow: false, message: prompt },
        });
      else await api("agent", { action: "send", id: a.id, prompt, images });
    } else if (composerState(null, S.view.s).live) {
      const s = S.view.s;
      await api("agent", {
        action: "live-send",
        profile: s.profile,
        sid: s.id,
        prompt,
        images,
      });
      sent.note = "Sent to its terminal, not read yet";
      // Ctrl+X Ctrl+S is Claude's; Codex has no such key.
      sent.sendNow = s.source === "claude";
      renderChat();
    } else {
      const s = S.view.s,
        created = await api("agent", {
          action: "create",
          profile: s.profile,
          cwd: s.cwd,
          sid: s.id,
          prompt,
          images,
        });
      if (created.queued) {
        Object.assign(sent, {
          dashed: true,
          note: created.busy
            ? "Queued after the current reply"
            : "Sent to Codex, not read yet",
        });
        renderChat();
      } else {
        drop();
        // The live stream may have added it already.
        if (!S.workspace.agents.some((x) => x.id === created.id))
          S.workspace.agents.unshift(created);
        S.view = { kind: "agent", id: created.id };
        S.chat.key = viewKey();
        history.replaceState({ chat: chatState() }, "");
        tellApp();
        renderChat();
      }
    }
    list.forEach((im) => URL.revokeObjectURL(im.url));
  } catch (e) {
    drop();
    renderChat();
    t.value = prompt;
    S.drafts[key] = prompt;
    grow(t);
    shellMode();
    if (list.length) {
      S.images[key] = list;
      renderAttachments();
    }
    toast(e.message);
  }
}
function updateLogin() {
  if (!S.login) return;
  const l = S.workspace.logins.find((l) => l.profile === S.login);
  if (!l) return;
  $("#login-output").textContent =
    l.output || "Waiting for the tool’s sign-in response…";
  const urls = l.output.match(/https:\/\/[^\s\u001b]+/g) || [];
  $("#login-links").innerHTML = [...new Set(urls)]
    .filter((u) => {
      try {
        return /(^|\.)(claude\.ai|anthropic\.com)$/.test(new URL(u).hostname);
      } catch {
        return false;
      }
    })
    .map(
      (u) =>
        `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">Open sign-in page ↗</a>`,
    )
    .join("");
  if (l.state === "complete" && !S.loginDone) {
    S.loginDone = true;
    toast(profileLabel(S.login) + " connected");
    void accounts();
  }
}
async function login(profile) {
  S.login = profile;
  S.loginDone = false;
  $("#login-title").textContent = "Connect " + profileLabel(profile);
  $("#login-output").textContent = "Starting sign-in…";
  $("#login-links").textContent = "";
  $("#login-dialog").showModal();
  try {
    const r = await api("login", { profile });
    if (r.authUrl) {
      const u = new URL(r.authUrl);
      if (u.protocol === "https:") {
        $("#login-links").innerHTML =
          `<a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">Sign in with ChatGPT ↗</a>`;
        $("#login-output").textContent =
          "Complete sign-in through the link, then check the connection.";
      }
    } else updateLogin();
  } catch (e) {
    $("#login-output").textContent = e.message;
  }
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button,[data-session],[data-child]");
  if (!b) return;
  try {
    if (b.dataset.page) navigate(b.dataset.page);
    if (b.dataset.slash) pickSlash(b.dataset.slash);
    if (b.dataset.termKey) sendTermKey(b.dataset.termKey);
    if (b.hasAttribute("data-mode")) switchMode();
    if (b.hasAttribute("data-open-terminal")) await openTerminal();
    if (b.hasAttribute("data-term")) {
      S.term = {
        key: S.chat.key,
        state: S.view.s.state,
        show: !termShown(S.view.s),
      };
      renderChat();
    }
    if (b.id === "new-agent" || b.hasAttribute("data-new")) openNew();
    if (b.hasAttribute("data-search")) openPalette();
    if (b.id === "sidebar-toggle")
      setSidebar(
        !document.documentElement.classList.contains("sidebar-hidden"),
      );
    if (b.hasAttribute("data-close-dialog")) $("#new-dialog").close();
    if (b.hasAttribute("data-close-login")) {
      $("#login-dialog").close();
      S.login = null;
    }
    if (b.hasAttribute("data-close-drawer")) leaveChat();
    if (b.hasAttribute("data-chat-size")) {
      S.chatFull = !S.chatFull;
      localStorage.setItem("cfind-chat-size", S.chatFull ? "full" : "panel");
      $("#drawer").classList.toggle("full", S.chatFull);
      renderChat();
    }
    if (b.dataset.child) {
      const s = S.metrics?.sessions.find(
        (s) =>
          s.profile === b.dataset.profileId &&
          (s.id === b.dataset.child || s.id === "agent-" + b.dataset.child),
      );
      if (s) openSession(s);
      else toast("This subagent has not written a local transcript yet.");
    }
    if (b.dataset.agent)
      openAgent(b.dataset.agent, b.dataset.owned === "1", b.dataset.profileId);
    if (b.hasAttribute("data-session")) {
      const s =
        S.metrics?.sessions.find((s) => s.path === b.dataset.path) ||
        S.sessions.find((s) => s.path === b.dataset.path);
      if (s) openSession(s);
    }
    if (b.hasAttribute("data-all-projects")) {
      S.allProjects = !S.allProjects;
      render();
    }
    if (b.hasAttribute("data-more")) {
      S.limit += 100;
      render();
    }
    if (b.hasAttribute("data-clear-search")) {
      S.search = "";
      S.sessions = [];
      S.deepSearch = false;
      S.remoteErrors = [];
      render();
    }
    if (b.hasAttribute("data-find")) {
      const find = $("#chat-find");
      find.hidden = !find.hidden;
      if (find.hidden) {
        $("#reader-q").value = "";
        markFind();
      } else $("#reader-q").focus();
    }
    if (b.hasAttribute("data-copy-code") || b.hasAttribute("data-copy-msg")) {
      const text = b.hasAttribute("data-copy-code")
        ? $("pre", b.closest(".md-code")).textContent
        : S.chatText.get(b.closest("[data-key]").dataset.key);
      await navigator.clipboard.writeText(text ?? "");
      const old = b.textContent;
      b.textContent = "Copied";
      setTimeout(() => (b.textContent = old), 1200);
    }
    if (b.hasAttribute("data-option")) {
      const q = b.closest(".ask-question"),
        on = b.getAttribute("aria-pressed") !== "true";
      if (!q.hasAttribute("data-multi"))
        $$(".ask-option", q).forEach((o) => {
          o.classList.remove("selected");
          o.setAttribute("aria-pressed", "false");
        });
      b.classList.toggle("selected", on);
      b.setAttribute("aria-pressed", String(on));
      const answers = readyAnswers(),
        single =
          $$(".ask-question").length === 1 &&
          !q.hasAttribute("data-multi") &&
          !$("[data-other]", q)?.value.trim();
      $('[data-respond="answer"]').disabled = !answers;
      // One single-choice question works like a quick reply.
      if (answers && single) $('[data-respond="answer"]').click();
    }
    if (b.hasAttribute("data-attach")) $("#image-input").click();
    if (b.dataset.removeImage) {
      const list = S.images[S.chat.key] || [],
        [im] = list.splice(Number(b.dataset.removeImage), 1);
      if (im) URL.revokeObjectURL(im.url);
      renderAttachments();
    }
    if (b.dataset.unqueue) {
      b.disabled = true;
      await api("agent", {
        action: "unqueue",
        id: S.view.id,
        index: Number(b.dataset.unqueue),
      });
    }
    if (b.hasAttribute("data-takeover")) {
      const key = S.chat.key,
        s = S.view.s;
      // Stopping the terminal process needs a second click.
      if (S.confirmTakeover !== key) {
        S.confirmTakeover = key;
        setTimeout(() => {
          if (S.confirmTakeover === key) S.confirmTakeover = null;
          renderChat();
        }, 4000);
      } else {
        S.confirmTakeover = null;
        b.disabled = true;
        await api("agent", {
          action: "takeover",
          profile: s.profile,
          sid: s.id,
        });
        S.view.s = { ...s, open: false, state: "stopped" };
        $("#agent-prompt").focus();
      }
      renderChat();
    }
    if (b.hasAttribute("data-dismiss")) {
      await api("agent", { action: "dismiss", id: S.view.id });
      closeDrawer();
      // The card is gone, so its step is too.
      history.replaceState(null, "");
    }
    if (b.hasAttribute("data-cancel")) {
      b.disabled = true;
      const s = S.view.kind === "session" ? S.view.s : null;
      await api(
        "agent",
        s
          ? { action: "live-stop", profile: s.profile, sid: s.id }
          : { action: "cancel", id: S.view.id },
      );
    }
    // Stops the reply or ! command, so what waits is sent at once.
    if (b.hasAttribute("data-send-now")) {
      b.disabled = true;
      const s = S.view.kind === "session" ? S.view.s : null;
      await api(
        "agent",
        s
          ? { action: "live-key", key: "send-now", profile: s.profile, sid: s.id }
          : { action: "send-now", id: S.view.id },
      );
      if (s) {
        (S.outbox[S.chat.key] || []).forEach((p) => delete p.sendNow);
        renderChat();
      }
    }
    if (b.dataset.respond) {
      const kind = b.dataset.respond;
      $$("[data-respond]").forEach((x) => (x.disabled = true));
      await api("agent", {
        action: "respond",
        id: S.view.id,
        answer:
          kind === "answer"
            ? { allow: true, answers: readyAnswers() }
            : { allow: kind !== "deny", always: kind === "always" },
      });
    }
    if (b.dataset.login) void login(b.dataset.login);
    if (b.hasAttribute("data-pair")) {
      b.disabled = true;
      S.pairing = await api("devices", { action: "pair-start" });
      await phones();
    }
    if (b.dataset.copyPair) {
      await navigator.clipboard.writeText(b.dataset.copyPair);
      b.textContent = "Copied";
    }
    if (b.dataset.revokeDevice) {
      b.disabled = true;
      await api("devices", { action: "revoke", id: b.dataset.revokeDevice });
      await phones();
      toast("iPhone removed");
    }
    if (b.hasAttribute("data-clear-uploads")) {
      b.disabled = true;
      const { removed } = await api("uploads", { action: "clear" });
      await uploads();
      toast(`${removed} image${removed === 1 ? "" : "s"} removed`);
    }
    if (
      b.hasAttribute("data-accounts-refresh") ||
      b.id === "refresh-accounts"
    ) {
      b.disabled = true;
      await accounts();
      b.disabled = false;
      toast("Connection status updated");
    }
  } catch (error) {
    toast(error.message);
    b.disabled = false;
  }
});
document.addEventListener("change", (e) => {
  if (e.target.matches("[data-profile]")) {
    S.profile = e.target.value;
    render();
  }
  if (e.target.matches("[data-project]")) {
    S.project = e.target.value;
    render();
  }
  if (e.target.matches("[data-days]")) {
    S.days = Number(e.target.value);
    render();
  }
  if (e.target.id === "image-input") {
    void attach([...e.target.files]);
    e.target.value = "";
  }
});
// Opened tool details can end below the fold; bring them into view. toggle does
// not bubble, so listen in the capture phase.
document.addEventListener(
  "toggle",
  (e) => {
    if (e.target.matches?.("details.tool-call") && e.target.open)
      e.target.scrollIntoView({ block: "nearest", behavior: "smooth" });
  },
  true,
);
document.addEventListener("paste", (e) => {
  if (e.target.id !== "agent-prompt" || e.target.disabled) return;
  const files = [...e.clipboardData.files].filter((f) =>
    f.type.startsWith("image/"),
  );
  if (!files.length) return;
  if (!e.clipboardData.getData("text/plain")) e.preventDefault();
  void attach(files);
});
// A file dropped anywhere else would make the browser leave the dashboard.
document.addEventListener("dragover", (e) => {
  if (e.dataTransfer.types.includes("Files")) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  if (!e.dataTransfer.types.includes("Files")) return;
  e.preventDefault();
  if (e.target.closest?.("#drawer") && !$("#agent-prompt")?.disabled)
    void attach([...e.dataTransfer.files]);
});
document.addEventListener("click", (e) => {
  const img = e.target.closest?.("[data-view-image]");
  if (img) {
    $("#image-dialog img").src = img.src;
    $("#image-dialog").showModal();
  } else if (e.target.closest?.("#image-dialog")) $("#image-dialog").close();
});
document.addEventListener("input", (e) => {
  if (e.target.id === "reader-q")
    markFind()?.scrollIntoView({ block: "center" });
  if (e.target.id === "agent-prompt") {
    S.drafts[S.chat.key] = e.target.value;
    grow(e.target);
    slashMenu();
    shellMode();
  }
  if (e.target.matches("[data-other]")) {
    const ready = $('[data-respond="answer"]');
    if (ready) ready.disabled = !readyAnswers();
  }
  if (e.target.id === "session-q") S.search = e.target.value;
});
document.addEventListener("submit", async (e) => {
  if (e.target.id === "new-form") {
    e.preventDefault();
    const b = $("[type=submit]", e.target);
    b.disabled = true;
    try {
      const f = new FormData(e.target),
        a = await api("agent", {
          action: "create",
          profile: f.get("profile"),
          cwd: f.get("cwd"),
          prompt: f.get("prompt"),
        });
      if (!S.workspace.agents.some((x) => x.id === a.id))
        S.workspace.agents.unshift(a);
      $("#new-dialog").close();
      navigate("workspace");
      openAgent(a.id, true);
    } catch (error) {
      $("#new-error").textContent = error.message;
    } finally {
      b.disabled = false;
    }
  }
  if (e.target.id === "agent-form") {
    e.preventDefault();
    await sendFromComposer();
  }
  if (e.target.id === "session-search") {
    e.preventDefault();
    const b = $("[type=submit]", e.target);
    b.disabled = true;
    b.textContent = "Searching…";
    try {
      const r = await api("search?q=" + encodeURIComponent(S.search));
      S.sessions = r.sessions;
      S.remoteErrors = r.errors;
      S.deepSearch = true;
      document.activeElement.blur();
      render();
    } catch (error) {
      toast(error.message);
      b.disabled = false;
      b.textContent = "Search full text ↵";
    }
  }
  if (e.target.id === "login-form") {
    e.preventDefault();
    try {
      await api("login", {
        action: "input",
        profile: S.login,
        input: $("#login-code").value,
      });
      $("#login-code").value = "";
    } catch (error) {
      toast(error.message);
    }
  }
});
// Single keys, as in Linear: only when not typing and no dialog is open.
const goKeys = {
  o: "overview",
  a: "workspace",
  s: "sessions",
  m: "machines",
};
function shortcut(e) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return false;
  if (e.target.closest?.("input,textarea,select,[contenteditable]"))
    return false;
  if ($("dialog[open]")) return false;
  if (shortcut.g && Date.now() - shortcut.g < 1000 && goKeys[e.key]) {
    shortcut.g = 0;
    navigate(goKeys[e.key]);
  } else if (e.key === "g") shortcut.g = Date.now();
  else if (e.key === "c") openNew();
  else if (e.key === "?") $("#keys-dialog").showModal();
  else return false;
  return true;
}
// The / menu: Claude's commands for this chat's profile and folder.
// Claude's model names for dashboard agents; /model with one changes the model
// for that agent only. A tmux chat opens Claude's own picker in the terminal view.
const MODELS = [
  { name: "model default", description: "Your usual model" },
  { name: "model opus", description: "Most capable" },
  { name: "model sonnet", description: "Fast and capable" },
  { name: "model haiku", description: "Fastest" },
];
function slashMenu() {
  const t = $("#agent-prompt"),
    m = $("#slash-menu"),
    q = /^\/(\S*|model\s+\S*)$/.exec(t?.value ?? "")?.[1]?.replace(/\s+/, " "),
    a = viewAgent(),
    s = S.view?.kind === "session" ? S.view.s : null,
    c = a || s;
  if (!m) return;
  if (q === undefined || t.disabled || !c?.profile) return (m.hidden = true);
  const key = c.profile + "\0" + c.cwd;
  if (!(key in S.commands)) {
    S.commands[key] = null;
    api(
      `commands?profile=${encodeURIComponent(c.profile)}&cwd=${encodeURIComponent(c.cwd)}`,
    )
      .then((d) => (S.commands[key] = d.commands))
      .catch((error) => (S.commands[key] = error.message))
      .finally(slashMenu);
  }
  const all = S.commands[key],
    live = composerState(a, s).live,
    rank = (name) => {
      const n = name.toLowerCase(),
        w = q.toLowerCase();
      return n.startsWith(w)
        ? 0
        : n.slice(n.lastIndexOf(":") + 1).startsWith(w)
          ? 1
          : n.includes(w)
            ? 2
            : 3;
    },
    found = !Array.isArray(all)
      ? []
      : q.includes(" ")
        ? (agentName(c.profile) === "Claude" && !live && q.startsWith("model ")
            ? MODELS : all).filter(x => x.name.includes(" ") && rank(x.name) === 0)
        : all
            .filter((x) => (live || !x.terminal) && rank(x.name) < 3)
            .sort(
              (x, y) =>
                rank(x.name) - rank(y.name) || x.name.localeCompare(y.name),
            );
  if (Array.isArray(all) && !found.length) return (m.hidden = true);
  if (m.dataset.q !== q) {
    m.dataset.q = q;
    S.slashAt = 0;
  }
  S.slashAt = Math.min(S.slashAt, Math.max(0, found.length - 1));
  m.innerHTML =
    all === null
      ? '<div class="slash-note">Loading commands…</div>'
      : typeof all === "string"
        ? `<div class="slash-note">${esc(all)}</div>`
        : found
            .map(
              (x, i) =>
                `<button type="button" class="slash-item${i === S.slashAt ? " active" : ""}" role="option" data-slash="${esc(x.name)}"><span class="slash-name">/${esc(x.name)}${x.hint ? ` <small>${esc(x.hint)}</small>` : ""}</span><span class="slash-desc">${esc(x.description || "")}</span></button>`,
            )
            .join("");
  m.hidden = false;
  m.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}
function slashKey(e) {
  const m = $("#slash-menu");
  if (e.target.id !== "agent-prompt" || !m || m.hidden || e.isComposing)
    return false;
  const items = $$("[data-slash]", m),
    pick = items[S.slashAt]?.dataset.slash;
  if (e.key === "Escape") m.hidden = true;
  else if (!items.length) return false;
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    S.slashAt =
      (S.slashAt + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
      items.length;
    slashMenu();
  } else if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
    // Enter on a command typed in full sends it.
    if (e.key === "Enter" && e.target.value === "/" + pick) {
      m.hidden = true;
      return false;
    }
    pickSlash(pick);
  } else return false;
  e.preventDefault();
  return true;
}
function pickSlash(name) {
  const t = $("#agent-prompt");
  if (name.startsWith("model ") || name.startsWith("effort ")) {
    t.value = "/" + name;
    $("#slash-menu").hidden = true;
    return $("#agent-form").requestSubmit();
  }
  t.value = "/" + name + " ";
  t.focus();
  t.dispatchEvent(new Event("input", { bubbles: true }));
}
// Clicking the menu keeps the cursor in the message box; leaving the box closes it.
document.addEventListener("mousedown", (e) => {
  if (e.target.closest?.("#slash-menu")) e.preventDefault();
});
document.addEventListener("focusout", (e) => {
  if (e.target.id === "agent-prompt")
    $("#slash-menu")?.setAttribute("hidden", "");
});
document.addEventListener("keydown", (e) => {
  if (slashKey(e) || termKeyDown(e)) return;
  if (
    e.key === "Tab" &&
    e.shiftKey &&
    !e.isComposing &&
    e.target.id === "agent-prompt" &&
    switchMode()
  )
    return e.preventDefault();
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    openPalette();
  }
  if (shortcut(e)) e.preventDefault();
  // ⌥⌘F in the Mac app: Option turns the key into "ƒ", so match the key's position.
  const app = window.webkit?.messageHandlers?.cfind;
  if (app && e.metaKey && e.altKey && e.code === "KeyF") {
    e.preventDefault();
    app.postMessage("window:fullscreen");
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "b") {
    e.preventDefault();
    setSidebar(!document.documentElement.classList.contains("sidebar-hidden"));
  }
  // ⌘1 to ⌘6 open the sidebar sections in order.
  const pages = $$(".nav-item[data-page]").map((b) => b.dataset.page),
    n = Number(e.key);
  if ((e.metaKey || e.ctrlKey) && !e.altKey && pages[n - 1]) {
    e.preventDefault();
    navigate(pages[n - 1]);
  }
  // Escape in an open dialog closes only the dialog; otherwise it closes the chat.
  if (e.key === "Escape" && !e.isComposing && !$("dialog[open]") && S.view)
    leaveChat();
  if (
    e.key === "Enter" &&
    !e.shiftKey &&
    !e.isComposing &&
    e.target.id === "agent-prompt"
  ) {
    e.preventDefault();
    $("#agent-form").requestSubmit();
  }
  if (
    e.key === "/" &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)
  ) {
    e.preventDefault();
    navigate("sessions");
    $("#session-q")?.focus();
  }
  if (e.key === "Enter" && e.target.matches("[data-session],[data-child]"))
    e.target.click();
});
window.addEventListener("hashchange", () => {
  const p = location.hash.slice(1);
  if (p !== S.page) navigate(p, true);
});
setInterval(() => {
  $("#clock").textContent = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (S.metrics) {
    $("#footer-update").textContent = `Updated ${age(S.metrics.updatedAt)}`;
    $$("[data-reset]").forEach((e) => {
      try {
        e.textContent = resetTime(JSON.parse(e.dataset.reset));
      } catch {}
    });
  }
}, 1000);
const icon = (paths) =>
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
function sourceIcon(source) {
  if (source === "codex")
    return icon(
      '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m8 9 4-2.3L16 9v6l-4 2.3L8 15V9Z"/><path d="M12 3v3.7M20 7.5 16 10M20 16.5 16 14M12 21v-3.7M4 16.5 8 14M4 7.5 8 10"/>',
    );
  return icon(
    '<path d="m12 2 .8 6.2L17 3.3l-2.6 5.8L21 7l-5 4.2 6 .8-6 1.1 4.8 4.1-6.2-2.3 2.4 6-4.2-4.8-.8 6-.9-6-4.2 4.8 2.5-6L3 17.2l4.9-4.1L2 12l6-.8L3 7l6.6 2.1L7 3.3l4.2 4.9L12 2Z"/>',
  );
}
const navIcons = {
  overview:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  workspace:
    '<rect x="3" y="5" width="18" height="14" rx="4"/><path d="m8 10 3 2-3 2m6 0h3"/>',
  sessions:
    '<path d="M8 4h9a3 3 0 0 1 3 3v12H8a4 4 0 0 1-4-4V6a2 2 0 0 1 4 0v13M11 8h5m-5 4h5"/>',
  machines:
    '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3 3-1 3 1 1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3-3 1-3-1Z"/>',
};
$$(".nav-item[data-page]").forEach((b) => {
  const span = b.querySelector("span");
  if (span) span.innerHTML = icon(navIcons[b.dataset.page] || "");
});
$("#new-agent span").innerHTML = icon('<path d="M12 5v14M5 12h14"/>');
$("[data-search] span").innerHTML = icon(
  '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
);
$("#sidebar-toggle").innerHTML = icon(
  '<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M9.5 4.5v15"/>',
);
// The Mac app's page runs under the title bar: empty space in the top rows
// moves the window, and a double click zooms it, as a title bar does.
document.addEventListener("mousedown", (e) => {
  const app = window.webkit?.messageHandlers?.cfind;
  if (
    !app ||
    e.button !== 0 ||
    !e.target.closest(".sidebar-top, .topbar, .drawer-head") ||
    e.target.closest("button, a, input, select, textarea")
  )
    return;
  // A drag must not start a text selection in the title.
  e.preventDefault();
  app.postMessage(e.detail === 2 ? "window:zoom" : "window:drag");
});
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("cfind-theme", theme);
  // The Mac app's glass follows the page, not the system appearance.
  window.webkit?.messageHandlers?.cfind?.postMessage("theme:" + theme);
  $("#theme-toggle").innerHTML = icon(
    theme === "dark"
      ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>'
      : '<path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z"/>',
  );
}
setTheme(
  localStorage.getItem("cfind-theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
);
function setSidebar(hidden) {
  document.documentElement.classList.toggle("sidebar-hidden", hidden);
  localStorage.setItem("cfind-sidebar", hidden ? "hidden" : "shown");
}
setSidebar(localStorage.getItem("cfind-sidebar") === "hidden");
// The board redraws often; keep unfolded subagents open across redraws.
document.addEventListener(
  "toggle",
  (e) => {
    const id = e.target.dataset?.parent;
    if (id) e.target.open ? S.openKids.add(id) : S.openKids.delete(id);
  },
  true,
);
$("#theme-toggle").onclick = () =>
  setTheme(
    document.documentElement.dataset.theme === "light" ? "dark" : "light",
  );
// ⌘K: commands first; with text, matching agents and sessions too.
function paletteItems(q) {
  const t = q.trim().toLowerCase(),
    has = (...s) => s.some((x) => String(x || "").toLowerCase().includes(t)),
    keys = { overview: "G O", workspace: "G A", sessions: "G S" },
    commands = [
      { label: "New agent", hint: "C", run: openNew },
      ...Object.entries(labels).map(([page, label]) => ({
        label: "Go to " + label,
        hint: keys[page],
        run: () => navigate(page),
      })),
      {
        label: "Switch appearance",
        run: () => $("#theme-toggle").click(),
      },
      {
        label: "Hide or show the sidebar",
        hint: "⌘B",
        run: () =>
          setSidebar(
            !document.documentElement.classList.contains("sidebar-hidden"),
          ),
      },
      {
        label: "Keyboard shortcuts",
        hint: "?",
        run: () => $("#keys-dialog").showModal(),
      },
    ].filter((c) => !t || has(c.label));
  if (!t) return commands;
  const agents = S.workspace.agents
      .filter((a) => has(a.title, a.cwd))
      .map((a) => ({
        label: a.title || "Agent session",
        sub: folder(a.cwd),
        hint: "Agent",
        run: () => openView({ kind: "agent", id: a.id }),
      })),
    sessions = (S.metrics?.sessions || [])
      .filter((s) => !s.parent && has(s.title, s.cwd))
      .slice(0, 12)
      .map((s) => ({
        label: s.title || "Session",
        sub: folder(s.cwd),
        hint: profileLabel(s.profile),
        run: () => openSession(s),
      }));
  return [...commands, ...agents, ...sessions].slice(0, 30);
}
function openPalette() {
  if ($("#palette").open) return;
  $("#palette-q").value = "";
  S.palette = 0;
  renderPalette();
  $("#palette").showModal();
  $("#palette-q").focus();
}
function renderPalette() {
  const items = (S.paletteItems = paletteItems($("#palette-q").value));
  S.palette = Math.max(0, Math.min(S.palette, items.length - 1));
  $("#palette-list").innerHTML = items.length
    ? items
        .map(
          (it, i) =>
            `<button type="button" role="option" class="palette-item${i === S.palette ? " active" : ""}" data-palette="${i}"><span>${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ""}</span>${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ""}</button>`,
        )
        .join("")
    : '<div class="palette-empty">No results</div>';
  $("#palette-list .active")?.scrollIntoView({ block: "nearest" });
}
function runPalette(i) {
  const it = S.paletteItems?.[i];
  if (!it) return;
  $("#palette").close();
  it.run();
}
$("#palette-q").oninput = () => {
  S.palette = 0;
  renderPalette();
};
$("#palette-q").onkeydown = (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    S.palette += e.key === "ArrowDown" ? 1 : -1;
    renderPalette();
  } else if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    runPalette(S.palette);
  }
};
$("#palette").onclick = (e) => {
  const b = e.target.closest("[data-palette]");
  if (b) runPalette(+b.dataset.palette);
  else if (e.target === e.currentTarget) e.currentTarget.close();
};
$("#keys-dialog").onclick = (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
};
connect();
navigate(S.page);
void accounts();

// The browser draws an open <select> with the operating system's menu. Keep the
// select for its value and change events, and draw the open list in page style.
function openMenu(select) {
  $(".select-menu")?.remove();
  const rect = select.getBoundingClientRect(),
    menu = document.createElement("div");
  menu.className = "select-menu";
  menu.popover = "auto";
  menu.setAttribute("role", "listbox");
  menu.innerHTML = [...select.options]
    .map(
      (o, i) =>
        `<button type="button" role="option" data-option-index="${i}" aria-selected="${o.selected}"${o.disabled ? " disabled" : ""}>${esc(o.textContent)}</button>`,
    )
    .join("");
  menu._select = select;
  // Inside a modal dialog, anything outside the dialog is inert.
  (select.closest("dialog") || document.body).append(menu);
  menu.style.minWidth = rect.width + "px";
  menu.style.left = Math.min(rect.left, innerWidth - rect.width - 8) + "px";
  menu.showPopover();
  const below = rect.bottom + 6;
  menu.style.top =
    (below + menu.offsetHeight > innerHeight - 8
      ? Math.max(8, rect.top - 6 - menu.offsetHeight)
      : below) + "px";
  menu.addEventListener("toggle", (e) => {
    if (e.newState !== "closed") return;
    const back = menu.contains(document.activeElement);
    menu.remove();
    if (back) select.focus();
  });
  (
    menu.querySelector('[aria-selected="true"]:not(:disabled)') ||
    menu.querySelector("button:not(:disabled)")
  )?.focus();
}
function chooseOption(menu, index) {
  const select = menu._select;
  menu.hidePopover();
  menu.remove();
  select.focus();
  if (select.selectedIndex === index) return;
  select.selectedIndex = index;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}
// Open on click: an auto popover shown during mousedown closes again on mouseup.
document.addEventListener("mousedown", (e) => {
  const select = e.target.closest?.("select");
  if (!select || select.multiple || select.disabled || e.button !== 0) return;
  e.preventDefault();
  select.focus();
  select._wasOpen = $(".select-menu")?._select === select;
});
document.addEventListener("click", (e) => {
  const select = e.target.closest?.("select");
  if (!select || select.multiple || select.disabled) return;
  if (select._wasOpen) $(".select-menu")?.hidePopover();
  else openMenu(select);
  select._wasOpen = false;
});
document.addEventListener("keydown", (e) => {
  const select = e.target.closest?.("select");
  if (
    select &&
    !select.multiple &&
    [" ", "Enter", "ArrowDown", "ArrowUp"].includes(e.key)
  ) {
    e.preventDefault();
    openMenu(select);
    return;
  }
  const menu = e.target.closest?.(".select-menu");
  if (!menu) return;
  const items = [...menu.querySelectorAll("button:not(:disabled)")],
    i = items.indexOf(document.activeElement),
    to = (n) => {
      e.preventDefault();
      items[Math.max(0, Math.min(items.length - 1, n))]?.focus();
    };
  if (e.key === "ArrowDown") to(i + 1);
  else if (e.key === "ArrowUp") to(i - 1);
  else if (e.key === "Home") to(0);
  else if (e.key === "End") to(items.length - 1);
  else if (e.key === "Tab") {
    e.preventDefault();
    menu.hidePopover();
  } else if (e.key.length === 1 && /\S/.test(e.key)) {
    const next = [...items.slice(i + 1), ...items.slice(0, i + 1)].find((b) =>
      b.textContent.trim().toLowerCase().startsWith(e.key.toLowerCase()),
    );
    if (next) to(items.indexOf(next));
  }
});
document.addEventListener("click", (e) => {
  const option = e.target.closest?.(".select-menu [data-option-index]");
  if (option)
    chooseOption(
      option.closest(".select-menu"),
      Number(option.dataset.optionIndex),
    );
});
