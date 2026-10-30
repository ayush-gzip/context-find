/** Snapshot changes for the live stream. Lists are sent by key, so a change to one
 *  session costs one row instead of the whole 600 KB snapshot. The client merges
 *  them with dashboard/delta.js. */

type Item = Record<string, any>;
export interface ListDelta {
  upsert?: Item[];
  removed?: string[];
  /** Key order, sent only for lists the client does not sort itself. */
  order?: string[];
  /** Text added to the end of a message: [id, text]. */
  append?: [string, string][];
}
export interface Delta {
  set?: Record<string, unknown>;
  lists?: Record<string, ListDelta>;
}

interface List {
  key: (x: Item) => string;
  /** The client sorts the list, so key order is not sent. */
  sorted?: boolean;
  /** A list inside each item that changes in small steps (agent messages). */
  nested?: string;
}
const LISTS: Record<string, List> = {
  sessions: { key: (s) => s.path, sorted: true },
  days: { key: (d) => `${d.day}|${d.profile}`, sorted: true },
  usage: {
    key: (u) => `${u.day}|${u.model}|${u.profile}|${u.cwd}`,
    sorted: true,
  },
  activity: {
    key: (a) => `${a.kind}|${a.profile}|${a.sessionId}|${a.agentId ?? ""}`,
    sorted: true,
  },
  agents: { key: (a) => a.id, nested: "messages" },
};

interface Seen {
  json: string;
  fields?: Map<string, string>;
  inner?: Map<string, { json: string; text: unknown }>;
}
interface Base {
  fields: Map<string, string>;
  lists: Map<string, { seen: Map<string, Seen>; keys: string[] }>;
}

const json = (v: unknown) => JSON.stringify(v) ?? "null";

function see(item: Item, nested?: string): Seen {
  if (!nested) return { json: json(item) };
  const fields = new Map<string, string>(),
    inner = new Map<string, { json: string; text: unknown }>();
  // An undefined field is missing on the wire, so it counts as removed.
  for (const [k, v] of Object.entries(item))
    if (k !== nested && v !== undefined) fields.set(k, json(v));
  for (const m of item[nested] ?? [])
    inner.set(String(m.id), { json: json(m), text: m.text });
  return { json: json(item), fields, inner };
}

/** Changed fields of an item; `null` marks a field that is gone. */
function itemPatch(
  key: string,
  item: Item,
  prev: Seen,
  now: Seen,
  nested: string,
) {
  const out: Item = { id: key };
  for (const [k, j] of now.fields!)
    if (prev.fields!.get(k) !== j) out[k] = item[k];
  for (const k of prev.fields!.keys()) if (!now.fields!.has(k)) out[k] = null;
  const items: Item[] = item[nested] ?? [];
  if (now.inner!.size !== items.length) {
    // Repeated ids cannot be merged by id; send the list whole.
    out[nested] = items;
    return out;
  }
  const list: ListDelta = {},
    keys: string[] = [];
  for (const m of items) {
    const id = String(m.id),
      p = prev.inner!.get(id),
      n = now.inner!.get(id)!;
    keys.push(id);
    if (!p) (list.upsert ??= []).push(m);
    else if (p.json === n.json) continue;
    else if (
      typeof p.text === "string" &&
      typeof m.text === "string" &&
      m.text.startsWith(p.text) &&
      json({ ...m, text: p.text }) === p.json
    )
      (list.append ??= []).push([id, m.text.slice(p.text.length)]);
    else (list.upsert ??= []).push(m);
  }
  for (const id of prev.inner!.keys())
    if (!now.inner!.has(id)) (list.removed ??= []).push(id);
  // The client keeps old messages in place and adds new ones at the end.
  const expected = [...prev.inner!.keys()].filter((id) => now.inner!.has(id));
  for (const id of keys) if (!prev.inner!.has(id)) expected.push(id);
  if (expected.join("\n") !== keys.join("\n")) list.order = keys;
  if (Object.keys(list).length) out[nested] = list;
  return out;
}

export class Deltas {
  private base?: Base;
  /** Changes since the last call. The first call only records the snapshot (send
   *  it whole); later calls return undefined when nothing changed. */
  next(snap: Item): Delta | undefined {
    const base: Base = { fields: new Map(), lists: new Map() },
      d: Delta = {};
    const set = (name: string, value: unknown) =>
      ((d.set ??= {})[name] = value);
    for (const [name, value] of Object.entries(snap)) {
      const spec = LISTS[name];
      if (!spec || !Array.isArray(value)) {
        const j = json(value);
        base.fields.set(name, j);
        if (this.base?.fields.get(name) !== j) set(name, value);
        continue;
      }
      const seen = new Map<string, Seen>(),
        keys = value.map((item) => {
          const k = spec.key(item);
          seen.set(k, see(item, spec.nested));
          return k;
        });
      const old = this.base?.lists.get(name);
      // Repeated keys cannot be merged by key; such a list is always sent whole.
      if (seen.size === keys.length) base.lists.set(name, { seen, keys });
      if (!old || seen.size !== keys.length) {
        set(name, value);
        continue;
      }
      const list: ListDelta = {};
      value.forEach((item, i) => {
        const k = keys[i]!,
          prev = old.seen.get(k),
          now = seen.get(k)!;
        if (!prev) (list.upsert ??= []).push(item);
        else if (prev.json !== now.json)
          (list.upsert ??= []).push(
            spec.nested ? itemPatch(k, item, prev, now, spec.nested) : item,
          );
      });
      for (const k of old.seen.keys())
        if (!seen.has(k)) (list.removed ??= []).push(k);
      if (!spec.sorted && keys.join("\n") !== old.keys.join("\n"))
        list.order = keys;
      if (Object.keys(list).length) (d.lists ??= {})[name] = list;
    }
    const first = !this.base;
    this.base = base;
    return first || (!d.set && !d.lists) ? undefined : d;
  }
}
