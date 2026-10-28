"use strict";
// Merges the live stream's metrics-delta and workspace-delta events (see
// src/delta.ts) into the last full snapshot.
(function (root) {
  const KEYS = {
    sessions: (s) => s.path,
    days: (d) => `${d.day}|${d.profile}`,
    usage: (u) => `${u.day}|${u.model}|${u.profile}|${u.cwd}`,
    activity: (a) => `${a.kind}|${a.profile}|${a.sessionId}|${a.agentId ?? ""}`,
    agents: (a) => a.id,
  };
  // The same orders the daemon uses, so lists come out as a full snapshot would.
  const SORTS = {
    sessions: (a, b) => b.updatedAt - a.updatedAt || (a.path < b.path ? -1 : 1),
    days: (a, b) =>
      a.day.localeCompare(b.day) || a.profile.localeCompare(b.profile),
  };
  const NESTED = { agents: "messages" };

  function mergeList(list, d, key, nested, sort) {
    const byKey = new Map(list.map((x) => [key(x), x]));
    for (const item of d.upsert || []) {
      const k = key(item),
        old = byKey.get(k);
      if (old && nested) {
        const next = { ...old };
        for (const [f, v] of Object.entries(item))
          if (v === null) delete next[f];
          else if (f === nested && !Array.isArray(v))
            next[f] = mergeList(old[f] || [], v, (m) => String(m.id));
          else next[f] = v;
        byKey.set(k, next);
      } else byKey.set(k, item);
    }
    for (const k of d.removed || []) byKey.delete(k);
    for (const [k, text] of d.append || []) {
      const m = byKey.get(k);
      if (m) byKey.set(k, { ...m, text: m.text + text });
    }
    const out = d.order
      ? d.order.map((k) => byKey.get(k)).filter(Boolean)
      : [...byKey.values()];
    return sort ? out.sort(sort) : out;
  }

  /** Returns a new snapshot; the old one is left as it was. */
  function applyDelta(snap, d) {
    const next = { ...snap, ...d.set };
    for (const [name, list] of Object.entries(d.lists || {}))
      next[name] = mergeList(
        snap[name] || [],
        list,
        KEYS[name],
        NESTED[name],
        SORTS[name],
      );
    return next;
  }

  root.cfindDelta = { applyDelta };
})(globalThis);
