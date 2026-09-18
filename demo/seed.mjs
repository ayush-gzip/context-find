// Builds a throwaway HOME with synthetic Claude Code and Codex transcripts for demo.tape.
// Nothing here comes from a real conversation.
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";

const HOME = join(import.meta.dirname, "home");
rmSync(HOME, { recursive: true, force: true });

const claude = (dir, branch, turns) => turns.flatMap(([u, a, tool]) => [
  { type: "user", cwd: dir, gitBranch: branch, timestamp: "2026-09-10T10:00:00Z", message: { content: u } },
  { type: "assistant", timestamp: "2026-09-10T10:01:00Z", message: { content: [
    { type: "text", text: a }, ...(tool ? [{ type: "tool_use", name: "Bash", input: { command: tool } }] : []) ] } },
]);
const codex = (dir, sid, turns) => [
  { type: "session_meta", timestamp: "2026-09-10T10:00:00Z", payload: { session_id: sid, cwd: dir } },
  ...turns.flatMap(([u, a, tool]) => [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: u }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: a }] } },
    ...(tool ? [{ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: tool }) } }] : []),
  ]),
];

const P = (p) => join(HOME, "projects", p);
const sessions = [
  ["claude", "api-gateway", "main", "3h", claude(P("api-gateway"), "main", [
    ["The rate limiter returns 429 even after the window resets. Can you look at the token bucket?",
     "The bucket refills on request time, not wall clock, so an idle client never earns tokens back. I'll switch the refill to a monotonic clock.", "grep -n refill src/ratelimit.ts"],
    ["Add exponential backoff to the retry path too", "Done. Retries now back off 200ms, 400ms, 800ms with jitter, capped at 5 attempts.", "npm test -- ratelimit"]])],
  ["codex", "worker", "-", "1d", codex(P("worker"), "019f3c2e-demo-0001", [
    ["Retry failed jobs after a rate limit response from the upstream API", "I'll requeue with a delay read from the Retry-After header and fall back to 30s.", "sed -n 1,80p jobs/retry.py"],
    ["Ship it", "Committed as 'retry: honour Retry-After on 429'."]])],
  ["claude", "dashboard", "feat/metrics", "2d", claude(P("dashboard"), "feat/metrics", [
    ["Show rate limit metrics on the deploy page before we roll out", "Added a panel for 429 count and p95 latency, sourced from the existing Prometheus endpoint."]])],
  ["codex", "infra", "-", "4d", codex(P("infra"), "019f3c2e-demo-0002", [
    ["Why does the docker build fail on arm64?", "The base image pins linux/amd64. Use a multi-arch tag and pass --platform.", "docker buildx ls"]])],
  ["claude", "blog", "main", "6d", claude(P("blog"), "main", [
    ["Draft a post about migrating from webpack to vite", "Here is an outline: motivation, the config diff, the two plugins that had no equivalent, and build time before and after."]])],
  ["claude", "api-gateway", "fix/auth", "9d", claude(P("api-gateway"), "fix/auth", [
    ["JWT validation rejects tokens issued a few seconds ago", "Clock skew. Allow a 30 second leeway on the nbf claim.", "grep -rn nbf src/auth"]])],
  ["codex", "cli-tools", "-", "12d", codex(P("cli-tools"), "019f3c2e-demo-0003", [
    ["Make the progress bar work when stdout is not a tty", "It now prints one line per 10% instead of redrawing."]])],
  ["claude", "mobile", "main", "15d", claude(P("mobile"), "main", [
    ["Fix the flaky login test on CI", "The test raced the splash animation. Waiting on the login button to be visible fixes it."]])],
];

const ago = (s) => Date.now() / 1000 - { h: 3600, d: 86400 }[s.at(-1)] * parseInt(s);
sessions.forEach(([src, proj, , when, rows], i) => {
  const file = src === "claude"
    ? join(HOME, ".claude", "projects", "-" + P(proj).replaceAll("/", "-").slice(1), `demo-${i}.jsonl`)
    : join(HOME, ".codex", "sessions", "2026", "09", "10", `rollout-2026-09-10-demo-${i}.jsonl`);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  utimesSync(file, ago(when), ago(when));
});
console.log("seeded", sessions.length, "sessions under", HOME);
