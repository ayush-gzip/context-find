// Records the iPhone app on a simulator while its demo UI test (testDemo in the
// cfind-apple repo) drives it. Writes public/phone.mp4 and public/phone.json, in
// the same shape as web.json. The test prints one CFIND_DEMO line per step.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export async function recordPhone({ base, token }, publicDir, cacheDir) {
  const apple = resolve(process.env.CFIND_APPLE ?? new URL("../../../cfind-apple", import.meta.url).pathname);
  if (!existsSync(join(apple, "cfind.xcodeproj"))) throw new Error(`No cfind-apple repo at ${apple}. Set CFIND_APPLE.`);
  const env = { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer" };
  const run = (cmd, args) => execFileSync(cmd, args, { env, encoding: "utf8", maxBuffer: 64 << 20 });
  const sim = process.env.CFIND_SIM ?? bootedIphone(run);
  const dd = join(cacheDir, "dd"), raw = join(cacheDir, "phone.mov");
  const xcode = ["-project", join(apple, "cfind.xcodeproj"), "-scheme", "cfind", "-destination", `id=${sim}`, "-derivedDataPath", dd];

  run("xcodebuild", [...xcode, "build-for-testing", "-quiet"]);
  run("xcrun", ["simctl", "ui", sim, "appearance", "light"]);
  run("xcrun", ["simctl", "ui", sim, "content_size", "large"]);
  run("xcrun", ["simctl", "status_bar", sim, "override", "--time", "9:41", "--batteryState", "charged",
    "--batteryLevel", "100", "--cellularBars", "4", "--wifiBars", "3"]);
  const { code } = await fetch(`${base}/api/devices?t=${token}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "pair-start" }),
  }).then((r) => r.json());

  const rec = spawn("xcrun", ["simctl", "io", sim, "recordVideo", "--codec", "h264", "--force", raw], { env });
  await new Promise((ok, fail) => {
    rec.stderr.on("data", (d) => /Recording started/.test(String(d)) && ok());
    rec.on("exit", () => fail(new Error("The simulator recording did not start")));
  });
  // The video's clock skips some of the long wait before the app starts, so it
  // is tied to this clock on screen instead: when the paired app is ready the
  // test prints "sync", the simulator goes dark for a moment at a noted time,
  // and the first dark frame marks that time in the video.
  let log = "", flip = 0;
  const appearance = (mode) => run("xcrun", ["simctl", "ui", sim, "appearance", mode]);
  const test = spawn("xcodebuild", [...xcode, "-only-testing:cfindUITests/CfindUITests/testDemo", "test-without-building"], {
    env: { ...env, TEST_RUNNER_CFIND_BASE: base, TEST_RUNNER_CFIND_CODE: code, TEST_RUNNER_CFIND_DEMO: "1" },
  });
  test.stdout.on("data", (d) => {
    log += d;
    if (!flip && /CFIND_DEMO \{"type":"sync"/.test(log)) {
      flip = Date.now() / 1000;
      appearance("dark");
      setTimeout(() => appearance("light"), 600);
    }
  });
  const status = await new Promise((ok) => test.on("close", ok));
  // A late sync line still works, if the flash is on video before it stops.
  await new Promise((ok) => setTimeout(ok, Math.max(0, flip + 1.5 - Date.now() / 1000) * 1000));
  rec.kill("SIGINT");
  await new Promise((ok) => rec.on("close", ok));
  if (status !== 0)
    throw new Error("testDemo failed:\n" + log.split("\n").filter((l) => /error|failed/.test(l)).join("\n"));
  if (!flip) throw new Error("testDemo printed no sync line. Is cfind-apple up to date?");

  const dark = darkFrame(raw, run);
  // The dark look shows about a quarter second after simctl is called.
  const at = (t) => +(t - flip - 0.25 + dark).toFixed(3);
  const events = [...log.matchAll(/CFIND_DEMO (\{.*\})/g)].map((m) => JSON.parse(m[1])).filter((e) => e.type !== "sync");
  for (const e of events) for (const k of ["t", "t0", "t1"]) if (k in e) e[k] = at(e[k]);
  const scenes = events.filter((e) => e.type === "scene");
  // The clip runs from just before the first scene to the "end" mark.
  const start = scenes[0].t - 0.3, duration = +(scenes.at(-1).t + 0.3 - start).toFixed(3);
  for (const e of events) for (const k of ["t", "t0", "t1"]) if (k in e) e[k] = +(e[k] - start).toFixed(3);
  // simctl writes a frame only when the screen changes: fill gaps before trimming.
  run("ffmpeg", ["-v", "error", "-y", "-i", raw, "-vf",
    `fps=30,trim=start=${start.toFixed(3)}:duration=${duration},setpts=PTS-STARTPTS,format=yuv420p`,
    "-c:v", "libx264", "-crf", "16", "-preset", "slow", "-movflags", "+faststart", join(publicDir, "phone.mp4")]);
  const [width, height] = run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
    "-of", "csv=p=0", raw]).trim().split(",").map(Number);
  writeFileSync(join(publicDir, "phone.json"), JSON.stringify({ width, height, duration, events }, null, 1));
  return { events: events.length, duration };
}

/** Video time of the first frame of the dark flash: the app is light, so it is
 *  the first frame much darker than a light one before it. */
function darkFrame(raw, run) {
  const stats = run("ffmpeg", ["-v", "error", "-i", raw, "-vf",
    "scale=64:-1,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-f", "null", "-"]);
  const t = [...stats.matchAll(/pts_time:([\d.]+)/g)].map((m) => +m[1]);
  const y = [...stats.matchAll(/YAVG=([\d.]+)/g)].map((m) => +m[1]);
  const i = y.findIndex((v, k) => v < 80 && y.slice(0, k).some((w) => w > 150));
  if (i < 0) throw new Error("No dark flash in the simulator recording");
  return t[i];
}

function bootedIphone(run) {
  const { devices } = JSON.parse(run("xcrun", ["simctl", "list", "devices", "booted", "-j"]));
  const sim = Object.values(devices).flat().find((d) => /iPhone/.test(d.name));
  if (!sim) throw new Error("Boot an iPhone simulator first, or set CFIND_SIM to its UDID");
  return sim.udid;
}
