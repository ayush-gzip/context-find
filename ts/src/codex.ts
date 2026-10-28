import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

/** One client connection. Closing it never stops the shared Codex daemon. */
export class CodexRPC {
  private child?: ChildProcessWithoutNullStreams;
  private socket?: WebSocket;
  private next = 0;
  private closed = false;
  private transport: Promise<void>;
  private pending = new Map<number, {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  readonly ready: Promise<void>;

  constructor(private event: (method: string, params: any, id?: any) => void) {
    if (process.env.CFIND_CODEX_BIN && !process.env.CFIND_CODEX_SOCKET) {
      // Protocol fixtures use a fake stdio binary, not the user's daemon.
      this.child = spawn(process.env.CFIND_CODEX_BIN, ["app-server", "--listen", "stdio://"]);
      createInterface({ input: this.child.stdout }).on("line", line => this.receive(line));
      this.child.stderr.on("data", () => {});
      this.child.on("error", error => this.fail(error));
      this.child.on("exit", () => this.fail(new Error("Codex connection closed")));
      this.transport = Promise.resolve();
    } else {
      const home = process.env.CODEX_HOME || join(homedir(), ".codex");
      const path = process.env.CFIND_CODEX_SOCKET || join(home, "app-server-control", "app-server-control.sock");
      this.socket = new WebSocket(`ws+unix://${path}:/`, {
        handshakeTimeout: 5000,
        maxPayload: 16 * 1024 * 1024,
      });
      this.transport = new Promise((resolve, reject) => {
        this.socket!.once("open", resolve);
        this.socket!.once("error", reject);
      });
      this.socket.on("message", data => this.receive(String(data)));
      this.socket.on("error", () => this.fail(new Error("Cannot connect to the local Codex server. Start Codex, then reopen this chat.")));
      this.socket.on("close", () => this.fail(new Error("Codex connection closed. Reopen the chat to reconnect.")));
    }
    this.ready = this.call("initialize", {
      clientInfo: { name: "context_find", title: "Context Find", version: "0.2.0" },
      capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
    }).then(() => this.send({ method: "initialized" }));
    this.ready.catch(() => {});
  }
  private receive(line: string) {
    try {
      const m = JSON.parse(line);
      if (m.id != null && !m.method) {
        const pending = this.pending.get(m.id);
        if (!pending) return;
        this.pending.delete(m.id);
        clearTimeout(pending.timer);
        if (m.error) pending.reject(new Error(m.error.message));
        else pending.resolve(m.result);
      } else if (m.method) this.event(m.method, m.params ?? {}, m.id);
    } catch {}
  }
  private send(message: any) {
    if (this.closed) throw new Error("Codex connection is closed");
    const text = JSON.stringify(message);
    if (this.socket) this.socket.send(text);
    else this.child!.stdin.write(text + "\n", error => { if (error) this.fail(error); });
  }
  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.event("connection/closed", { message: error.message });
  }
  async call(method: string, params: any = {}): Promise<any> {
    await this.transport;
    if (this.closed) throw new Error("Codex connection is closed");
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  respond(id: any, result: any) { this.send({ id, result }); }
  close() {
    this.fail(new Error("Codex connection closed"));
    this.socket?.close();
    this.child?.kill();
  }
}
