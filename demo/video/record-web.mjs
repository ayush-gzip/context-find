// Records the web dashboard of the demo daemon (made-up data only). Writes
// public/web.mp4 and public/web.json: scene marks, mouse moves, clicks, typing
// and scrolls, in seconds from the first frame, with positions as 0-1 of the page.
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const W = 1440, H = 810;
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);

export async function recordWeb({ base, token, iconAgent }, publicDir, cacheDir) {
  const dir = join(cacheDir, "web-frames");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Screencast frames come at the page's size in CSS pixels unless the browser
  // itself runs at 2x and the page metrics are set again; zoomed shots need 2x.
  const b = await chromium.launch({ channel: "chrome", headless: true, args: ["--force-device-scale-factor=2"] });
  const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: "light" });
  const p = await ctx.newPage();
  await p.addInitScript(() => localStorage.setItem("theme", "light"));

  // Frames come over the DevTools protocol when the page changes. Their clock may
  // differ from Date.now(), so each frame also keeps the time it arrived.
  const frames = [], events = [], now = () => Date.now() / 1000;
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  cdp.on("Page.screencastFrame", (f) => {
    const file = join(dir, `f${String(frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp, seen: now() });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });

  const wait = (ms) => p.waitForTimeout(ms);
  let at = { x: W / 2, y: H / 2 };
  const center = async (loc) => {
    const box = await loc.boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  // The page draws no cursor; the edit draws one along these moves.
  const moveTo = async (loc, ms = 700) => {
    const to = await center(loc), from = at, t0 = now(), n = 28;
    for (let i = 1; i <= n; i++) {
      const k = ease(i / n);
      await p.mouse.move(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k);
      await wait(ms / n);
    }
    events.push({ type: "move", t0, t1: now(), x0: from.x / W, y0: from.y / H, x1: to.x / W, y1: to.y / H });
    at = to;
  };
  const click = async (loc) => {
    await moveTo(loc);
    await wait(200);
    events.push({ type: "click", t: now(), x: at.x / W, y: at.y / H });
    await p.mouse.down();
    await wait(90);
    await p.mouse.up();
  };
  const type = async (text) => {
    const t0 = now();
    await p.keyboard.type(text, { delay: 120 });
    events.push({ type: "type", t0, t1: now(), x: at.x / W, y: at.y / H });
  };
  const scroll = async (dy, times, gap) => {
    const t0 = now();
    for (let i = 0; i < times; i++) {
      await p.mouse.wheel(0, dy);
      await wait(gap);
    }
    events.push({ type: "scroll", t0, t1: now() });
  };
  const scene = (id) => events.push({ type: "scene", t: now(), id });

  await p.goto(`${base}/?t=${token}#overview`);
  await p.waitForFunction(() => typeof S !== "undefined" && S.metrics?.sessions?.length);
  await wait(800);
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W * 2, maxHeight: H * 2 });
  await p.mouse.move(at.x, at.y);
  scene("overview");
  await wait(1500);
  await moveTo(p.locator(".nav-item[data-page=\"overview\"]"), 900);
  await wait(600);
  await moveTo(p.locator("main"), 900);
  await scroll(130, 2, 450);
  await wait(1400);
  await scroll(-130, 2, 300);
  await wait(500);

  // Full-text search finds a phrase that is only in a reply's code.
  scene("search");
  await click(p.locator(".nav-item[data-page=\"sessions\"]"));
  await wait(1000);
  await click(p.locator("#session-q"));
  await type("waitFor");
  await wait(500);
  await click(p.locator("#session-search button[type=\"submit\"]"));
  await p.waitForFunction(() => S.deepSearch, null, { timeout: 15000 }).catch(() => {});
  await wait(1400);

  scene("chat");
  await click(p.locator("tr[data-path]").first());
  await wait(2200);
  await moveTo(p.locator("#chat-list"));
  await scroll(220, 6, 260);
  await wait(1800);
  await p.keyboard.press("Escape");
  await wait(700);

  // An agent asks a question; one click answers it.
  scene("ask");
  await click(p.locator(".nav-item[data-page=\"workspace\"]"));
  await wait(1500);
  await click(p.locator(`.agent-card[data-agent="${iconAgent}"]`));
  await wait(2000);
  await click(p.locator(".ask-option[data-label=\"Glass lens\"]"));
  await wait(500);
  const send = p.getByRole("button", { name: "Send answer" });
  if (await send.isVisible().catch(() => false)) await click(send);
  await wait(4000);
  scene("end");
  await wait(300);

  await cdp.send("Page.stopScreencast");
  await wait(300);
  await b.close();
  if (frames.length < 2) throw new Error("The dashboard recorded no frames");
  // The first frames can arrive out of order.
  frames.sort((x, y) => x.t - y.t);

  // Events in video time: the median gap between a frame's own clock and when it
  // arrived maps Date.now() onto the frame clock.
  const gaps = frames.map((f) => f.t - f.seen).sort((x, y) => x - y);
  const shift = gaps[gaps.length >> 1] - frames[0].t;
  const v = (t) => +(t + shift).toFixed(3);
  for (const e of events)
    for (const k of ["t", "t0", "t1"]) if (k in e) e[k] = v(e[k]);
  const duration = frames.at(-1).t - frames[0].t + 0.5;

  // ffmpeg concat list: each frame lasts until the next one.
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.t ?? f.t + 0.5) - f.t).toFixed(4)}`);
  writeFileSync(join(dir, "frames.txt"), list.join("\n") + `\nfile '${frames.at(-1).file}'\n`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(dir, "frames.txt"),
    "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "16", "-preset", "slow", "-movflags", "+faststart",
    join(publicDir, "web.mp4")]);
  writeFileSync(join(publicDir, "web.json"), JSON.stringify({ width: W, height: H, duration: +duration.toFixed(3), events }, null, 1));
  return { frames: frames.length, duration };
}
