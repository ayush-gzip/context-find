// npm run demo: starts the made-up-data daemon, records the web dashboard and
// the iPhone app, then renders the 16:9 and 9:16 videos into out/.
//   --record-only   record, do not render
//   --render-only   render the recordings already in public/
//   --no-phone      skip the iPhone (no Xcode); the video then has no iPhone part
//   --gif           also render out/cfind-demo.gif for the README
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { recordWeb } from "./record-web.mjs";
import { recordPhone } from "./record-phone.mjs";

const here = import.meta.dirname, flag = (f) => process.argv.includes(f);
const pub = join(here, "public"), cache = join(here, ".cache"), out = join(here, "out");
for (const d of [pub, cache, out]) mkdirSync(d, { recursive: true });

if (!flag("--render-only")) {
  const state = join(cache, "demo.json");
  rmSync(state, { force: true });
  const harness = spawn(process.execPath, ["--loader", join(here, "../../ts/test/typescript-loader.mjs"), "harness.mjs", state],
    { cwd: here, stdio: ["ignore", "ignore", "inherit"] });
  try {
    for (let i = 0; !existsSync(state); i++) {
      if (i > 150 || harness.exitCode !== null) throw new Error("The demo daemon did not start");
      await new Promise((r) => setTimeout(r, 200));
    }
    const demo = JSON.parse(readFileSync(state, "utf8"));
    console.log("web:", await recordWeb(demo, pub, cache));
    if (flag("--no-phone")) rmSync(join(pub, "phone.json"), { force: true });
    else console.log("phone:", await recordPhone(demo, pub, cache));
  } finally {
    harness.kill("SIGTERM");
  }
}

if (!flag("--record-only")) {
  const remotion = (...args) => execFileSync(join(here, "node_modules/.bin/remotion"), args, { cwd: here, stdio: "inherit" });
  remotion("render", "src/index.ts", "Demo", join(out, "cfind-demo.mp4"));
  remotion("render", "src/index.ts", "DemoVertical", join(out, "cfind-demo-vertical.mp4"));
  if (flag("--gif"))
    remotion("render", "src/index.ts", "Demo", join(out, "cfind-demo.gif"), "--codec=gif", "--every-nth-frame=2", "--scale=0.5");
}
