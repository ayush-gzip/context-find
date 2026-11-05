// A cfind daemon with made-up sessions, for the demo video and screenshots.
// Own HOME, data dir and port; never the user's daemon or ~/.claude* dirs.
// demo.mjs runs it: node --loader ../../ts/test/typescript-loader.mjs harness.mjs <out.json>
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, utimesSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const repo = new URL("../../ts", import.meta.url).pathname, out = process.argv[2];
const home = realpathSync(mkdtempSync(join(tmpdir(), "cfind-demo-")));
const bin = join(home, "bin"), data = join(home, "data");
mkdirSync(bin);
Object.assign(process.env, {
  HOME: home,
  CFIND_DATA_DIR: data,
  CODEX_HOME: join(home, ".codex"),
  CFIND_CLAUDE_BIN: join(bin, "claude"),
  CFIND_TMUX_BIN: "/usr/bin/false",
  CFIND_TAILSCALE_BIN: "/usr/bin/false",
});
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.TMUX;

// Dashboard agents. "icon" asks a question with options; "slow" works for 10 minutes;
// anything else answers in a moment with Markdown and code.
writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
const send=o=>console.log(JSON.stringify(o));let n=0;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 const say=t=>send({type:'assistant',message:{id:'r'+(n++),content:[{type:'text',text:t}]}});
 if(m.type==='control_request'){send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});return;}
 if(m.type==='control_response'&&m.response&&m.response.request_id==='q1'){
  const pick=(JSON.stringify(m).match(/Glass lens|Chat bubble|Monogram/)||['that one'])[0];
  setTimeout(()=>{say('Going with **'+pick+'**. I will finish it at 1024 px and export every app size.');
   send({type:'result',subtype:'success',is_error:false,result:''});},1200);return;}
 if(m.type!=='user')return;
 const c=m.message.content,text=typeof c==='string'?c:c.map(x=>x.text||'').join(' ');
 send({type:'system',subtype:'init',session_id:'agent-'+process.pid,model:'opus',permissionMode:'default'});
 if(/icon/i.test(text)){
  say('I made three directions for the app icon. They are in design/icons.');
  setTimeout(()=>send({type:'control_request',request_id:'q1',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',
   input:{questions:[{header:'Icon',question:'Which icon direction should I finish?',multiSelect:false,options:[
    {label:'Glass lens',description:'A frosted search lens with a soft glow'},
    {label:'Chat bubble',description:'A rounded bubble with a cursor inside'},
    {label:'Monogram',description:'A bold lowercase c'}]}]}}}),400);
  return;}
 const f=String.fromCharCode(96).repeat(3);
 if(/release notes/i.test(text)){setTimeout(()=>{say('Here are the notes for 2.3:\\n\\n## What is new\\n- Search is 10 times faster\\n- Chats look like Messages, with code in cards\\n- Questions from an agent show as buttons you can tap\\n- Usage shows what is left this week');send({type:'result',subtype:'success',is_error:false,result:''});},1500);return;}
 if(/shorter|bullets/i.test(text)){setTimeout(()=>{say('Shorter:\\n\\n- 10x faster search\\n- Messages-style chats\\n- Tap to answer questions');send({type:'result',subtype:'success',is_error:false,result:''});},1800);return;}
 setTimeout(()=>{say('Done. The retry now waits **250 ms** and gives up after 3 tries:\\n\\n'+f+'ts\\nawait retry(() => upload(file), { tries: 3, delay: 250 });\\n'+f);
  send({type:'result',subtype:'success',is_error:false,result:''});},/slow/.test(text)?600000:1500);
});`, { mode: 0o700 });

const now = Date.now(), min = 60_000;
const at = (ago) => new Date(now - ago).toISOString();
function project(profileDir, cwd) {
  mkdirSync(cwd, { recursive: true });
  const dir = join(home, profileDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}
const usage = () => ({ input_tokens: 800 + Math.floor(Math.random() * 4000), output_tokens: 300 + Math.floor(Math.random() * 2500),
  cache_read_input_tokens: 20000 + Math.floor(Math.random() * 60000), cache_creation_input_tokens: Math.floor(Math.random() * 6000) });
const made = [];
/** A Claude transcript from [ago, kind, value] steps. */
function claude(profileDir, cwd, steps) {
  const sid = randomUUID(), dir = project(profileDir, cwd), lines = [];
  const base = (type, ago) => ({ type, uuid: randomUUID(), sessionId: sid, cwd, gitBranch: "main", timestamp: at(ago) });
  let last = 0;
  for (const [ago, kind, v, extra] of steps) {
    last = ago;
    if (kind === "user") lines.push({ ...base("user", ago), message: { role: "user", content: v } });
    else if (kind === "say")
      lines.push({ ...base("assistant", ago), message: { id: randomUUID(), role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: v }], usage: usage() } });
    else if (kind === "tool") {
      const id = "toolu_" + randomUUID().slice(0, 8);
      lines.push({ ...base("assistant", ago), message: { id: randomUUID(), role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id, name: v, input: extra.input }], usage: usage() } });
      lines.push({ ...base("user", ago - 1000), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: extra.output }] } });
    }
  }
  const path = join(dir, sid + ".jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const t = (now - last) / 1000;
  utimesSync(path, t, t);
  const info = { sid, path, last: now - last };
  made.push(info);
  return info;
}

const work = (name) => join(home, "work", name);

// The chat shown in screenshots: tools, code, a table, a run of replies and a gap.
const ended = [];
const checkout = claude(".claude", work("shop-api"), [
  [46 * min, "user", "The checkout test fails about 1 in 5 runs on CI. Can you find out why?"],
  [45.5 * min, "say", "I'll run it a few times and read the test first."],
  [45 * min, "tool", "Bash", { input: { command: "npm test -- checkout --repeat 20" }, output: "17 passed, 3 failed\n  ✕ applies the coupon before tax (timeout)" }],
  [44 * min, "tool", "Read", { input: { file_path: "test/checkout.test.ts" }, output: "it('applies the coupon before tax', async () => { ... })" }],
  [43 * min, "say", "Found it. The test reads the cart total **before** the price update lands. On a slow runner the update comes second."],
  [42.8 * min, "say", "I changed the test to wait for the update:\n\n```ts\nawait cart.applyCoupon(\"SAVE10\");\nawait waitFor(() => cart.total !== before);\nexpect(cart.total).toBe(90);\n```"],
  [42.5 * min, "say", "Running it 50 times to be sure."],
  [12 * min, "user", "Nice. Does it pass every time now?"],
  [11 * min, "tool", "Bash", { input: { command: "npm test -- checkout --repeat 50" }, output: "50 passed, 0 failed" }],
  [10 * min, "say", "Yes. 50 of 50 passed.\n\n| Run | Before | After |\n|---|---|---|\n| CI | 3 of 20 fail | 0 of 50 fail |\n| Local | 1 of 20 fail | 0 of 50 fail |\n\nShould I open a pull request?"],
]);
const ask = claude(".claude", work("ios-app"), [
  [30 * min, "user", "Get build 2.3 ready for TestFlight"],
  [25 * min, "tool", "Bash", { input: { command: "xcodebuild -scheme App archive" }, output: "** ARCHIVE SUCCEEDED **" }],
  [3 * min, "tool", "Bash", { input: { command: 'cfind ask "Upload build 2.3 (412) to TestFlight now?"' }, output: "" }],
]);
const busy = claude(".claude-personal", work("blog"), [
  [2 * min, "user", "Write a short post about the new search: it went from 6 seconds to half a second"],
  [1 * min, "say", "Drafting it now in posts/fast-search.md."],
]);
ended.push(["claude", claude(".claude", work("infra"), [[3 * 60 * min, "user", "Move the nightly backup to 2 am and keep 14 days"], [3 * 60 * min - 5000, "say", "Done. The cron runs at 02:00 and old backups are removed after 14 days."]]), work("infra")]);
ended.push(["personal", claude(".claude-personal", work("dotfiles"), [[26 * 60 * min, "user", "Add a git alias that shows the last 10 commits as one line each"], [26 * 60 * min - 5000, "say", "Added `git last`."]]), work("dotfiles")]);
ended.push(["claude", claude(".claude", work("shop-api"), [[2 * 24 * 60 * min, "user", "Add rate limits to the public API: 100 requests a minute per key"], [2 * 24 * 60 * min - 5000, "say", "Added. Over the limit returns 429 with a Retry-After header."]]), work("shop-api")]);
ended.push(["personal", claude(".claude-personal", work("recipes"), [[4 * 24 * 60 * min, "user", "Turn my recipe notes into a searchable static site"], [4 * 24 * 60 * min - 5000, "say", "The site builds with `npm run build`."]]), work("recipes")]);

for (const [days, folderName, ask] of [[1, "shop-api", "Add a health check endpoint that reports the database status"], [3, "ios-app", "Fix the crash when the photo picker is closed fast"], [5, "infra", "Rotate the staging TLS certificate"], [6, "blog", "Add an RSS feed"], [8, "shop-api", "Speed up the order list query"], [9, "dotfiles", "Make the prompt show the git branch"], [11, "ios-app", "Add haptics to the send button"], [12, "recipes", "Add tags to recipes"]]) {
  const ago = days * 24 * 60 * min;
  ended.push(["claude", claude(".claude", work(folderName), [[ago, "user", ask], [ago - 60000, "say", "Done."], [ago - 120000, "say", "All tests pass."]]), work(folderName)]);
}

// A Codex session.
const [y, mo, d] = new Date(now).toISOString().slice(0, 10).split("-");
mkdirSync(join(home, ".codex", "sessions", y, mo, d), { recursive: true });
const codexPath = join(home, ".codex", "sessions", y, mo, d, `rollout-${y}-${mo}-${d}T08-00-00-${randomUUID()}.jsonl`);
writeFileSync(codexPath, [
  { timestamp: at(50 * min), type: "session_meta", payload: { id: randomUUID(), cwd: work("docs-site"), timestamp: at(50 * min) } },
  { timestamp: at(50 * min), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the broken links in the docs sidebar" }] } },
  { timestamp: at(48 * min), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixed 4 links that pointed at old page names." }] } },
].map((l) => JSON.stringify(l)).join("\n") + "\n");
utimesSync(codexPath, (now - 48 * min) / 1000, (now - 48 * min) / 1000);

// State and usage signals, as the Claude hooks and status line write them.
const { recordSignal } = await import(repo + "/src/collector.ts");
recordSignal("personal", { session_id: busy.sid, hook_event_name: "UserPromptSubmit", cwd: work("blog") }, data);
recordSignal("claude", { session_id: ask.sid, hook_event_name: "Stop", cwd: work("ios-app") }, data);
recordSignal("claude", { session_id: checkout.sid, hook_event_name: "Stop", cwd: work("shop-api") }, data);
for (const [profile, t, cwd] of ended) recordSignal(profile, { session_id: t.sid, hook_event_name: "SessionEnd", cwd }, data);
const limits = (s, w) => ({ five_hour: { used_percentage: s, resets_at: Math.round(now / 1000) + 2 * 3600 + 900 }, seven_day: { used_percentage: w, resets_at: Math.round(now / 1000) + 3 * 86400 } });
recordSignal("claude", { session_id: ask.sid, cwd: work("ios-app"), rate_limits: limits(38, 61) }, data, "statusline");
recordSignal("personal", { session_id: busy.sid, cwd: work("blog"), rate_limits: limits(12, 27) }, data, "statusline");

// Signals are stamped now; a finished session shows its last message time instead.
const lastOf = new Map(made.map((t) => [t.sid, t.last]));
for (const name of readdirSync(join(data, "signals"))) {
  const file = join(data, "signals", name), signal = JSON.parse(readFileSync(file, "utf8"));
  if (lastOf.has(signal.sessionId) && signal.state !== "running") {
    signal.updatedAt = lastOf.get(signal.sessionId);
    writeFileSync(file, JSON.stringify(signal));
  }
}

const { createWebServer } = await import(repo + "/src/web.ts");
const { server, token, workspace } = createWebServer([]);
await new Promise((r) => server.listen(Number(process.env.DEMO_PORT || 0), "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = (path, body) =>
  fetch(`${base}/api/${path}?t=${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; });
const agent = (cwd, prompt) => post("agent", { action: "create", profile: "claude", cwd, prompt }).then((a) => a.id);
mkdirSync(work("brand"), { recursive: true });
mkdirSync(work("site"), { recursive: true });
await agent(work("site"), "Write release notes for version 2.3");
const iconAgent = await agent(work("brand"), "Design a new app icon for cfind");
await agent(work("shop-api"), "slow: update every dependency and run the full test suite");

let closed = false;
const cleanup = () => {
  if (closed) return;
  closed = true;
  try { workspace.close(); } catch {}
  try { server.closeAllConnections(); server.close(); } catch {}
  rmSync(home, { recursive: true, force: true });
};
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("exit", cleanup);
writeFileSync(out, JSON.stringify({ base, token, home, iconAgent }), { mode: 0o600 });
console.log("ready " + base);
