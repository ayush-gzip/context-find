// Turns a recording's events into what the edit needs at a given time: the scene,
// the camera (center and zoom), the cursor and the clicks. Times are in seconds
// from the start of the clip; positions are 0-1 of the page or screen.

export type Ev =
  | { type: "scene"; t: number; id: string }
  | { type: "move"; t0: number; t1: number; x0: number; y0: number; x1: number; y1: number }
  | { type: "click" | "tap"; t: number; x: number; y: number }
  | { type: "type"; t0: number; t1: number; x: number; y: number }
  | { type: "scroll" | "swipe"; t0: number; t1: number };

export type Take = { width: number; height: number; duration: number; events: Ev[] };

export const INTRO = 3, OUTRO = 3.5, FADE = 0.6;

export const inOut = (k: number) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2);

export function scenes(take: Take) {
  const marks = take.events.filter((e) => e.type === "scene");
  return marks
    .map((m, i) => ({ id: m.id, from: m.t, to: marks[i + 1]?.t ?? take.duration }))
    .filter((s) => s.id !== "end");
}

type Key = { t: number; x: number; y: number; z: number };

/** Zooms in on each click or typed field and back out. Points close in time
 *  share one zoom and the camera pans between them, as Screen Studio does. */
export function cameraKeys(take: Take, zoom: number): Key[] {
  const IN = 0.7, OUT = 0.8, PAN = 0.6;
  const focus = take.events
    .flatMap((e) =>
      e.type === "click" || e.type === "tap"
        ? [{ from: e.t - 0.8, to: e.t + 1.2, x: e.x, y: e.y }]
        : e.type === "type"
          ? [{ from: e.t0 - 0.4, to: e.t1 + 0.8, x: e.x, y: e.y }]
          : [],
    )
    .sort((a, b) => a.from - b.from);
  const keys: Key[] = [{ t: 0, x: 0.5, y: 0.5, z: 1 }];
  const add = (t: number, x: number, y: number, z: number) => keys.push({ t: Math.max(t, keys.at(-1)!.t), x, y, z });
  for (let i = 0; i < focus.length; ) {
    let j = i, end = focus[i].to;
    while (j + 1 < focus.length && focus[j + 1].from < end + IN + OUT) end = Math.max(end, focus[++j].to);
    add(focus[i].from, 0.5, 0.5, 1);
    add(keys.at(-1)!.t + IN, focus[i].x, focus[i].y, zoom);
    for (let k = i + 1; k <= j; k++) {
      add(focus[k].from, focus[k - 1].x, focus[k - 1].y, zoom);
      add(keys.at(-1)!.t + PAN, focus[k].x, focus[k].y, zoom);
    }
    add(end, focus[j].x, focus[j].y, zoom);
    add(keys.at(-1)!.t + OUT, 0.5, 0.5, 1);
    i = j + 1;
  }
  return keys;
}

export function cameraAt(keys: Key[], t: number) {
  const b = keys.findIndex((k) => k.t > t);
  if (b <= 0) return b === 0 ? keys[0] : keys.at(-1)!;
  const a = keys[b - 1], c = keys[b], k = inOut((t - a.t) / (c.t - a.t));
  // Zoom eases in log space, so going 1x to 2x feels as even as 2x to 4x.
  const z = Math.exp(Math.log(a.z) + (Math.log(c.z) - Math.log(a.z)) * k);
  return { x: a.x + (c.x - a.x) * k, y: a.y + (c.y - a.y) * k, z };
}

export function cursorAt(take: Take, t: number) {
  let p = { x: 0.5, y: 0.5 };
  for (const e of take.events) {
    if (e.type !== "move" || e.t0 > t) continue;
    const k = t >= e.t1 ? 1 : inOut((t - e.t0) / (e.t1 - e.t0));
    p = { x: e.x0 + (e.x1 - e.x0) * k, y: e.y0 + (e.y1 - e.y0) * k };
  }
  return p;
}

/** Where the cursor was over the last 0.8 s, for a camera that trails it. */
export function cursorTrail(take: Take, t: number) {
  const ps = Array.from({ length: 9 }, (_, i) => cursorAt(take, t - i * 0.1));
  return { x: ps.reduce((n, p) => n + p.x, 0) / ps.length, y: ps.reduce((n, p) => n + p.y, 0) / ps.length };
}

/** Clicks or taps that started in the last `span` seconds, with their age 0-1. */
export function presses(take: Take, t: number, span: number) {
  return take.events.flatMap((e) =>
    (e.type === "click" || e.type === "tap") && t >= e.t && t < e.t + span ? [{ ...e, age: (t - e.t) / span }] : [],
  );
}
