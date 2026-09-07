import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tests = readdirSync(new URL("./", import.meta.url))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => fileURLToPath(new URL(name, import.meta.url)));
const result = spawnSync(process.execPath, [
  "--loader", fileURLToPath(new URL("./typescript-loader.mjs", import.meta.url)),
  "--test", ...tests,
], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
