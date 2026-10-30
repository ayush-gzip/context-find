import { watch, type FSWatcher } from "node:fs";
import { ConversationReader, type ChatView } from "./conversation.ts";

export type ChatSend = (event: "chat" | "chat-delta", view: ChatView) => void;
interface Feed {
  reader: ConversationReader;
  peers: Set<ChatSend>;
  watcher?: FSWatcher;
  poll?: ReturnType<typeof setInterval>;
  queued?: ReturnType<typeof setTimeout>;
  linger?: ReturnType<typeof setTimeout>;
}

/** Pushes new transcript messages to open chats the moment the file changes. A
 *  reader stays warm for a while after its last chat closes, so reopening is quick. */
export class ChatFeeds {
  private feeds = new Map<string, Feed>();
  private lingerMs: number;
  constructor(lingerMs = 30000) {
    this.lingerMs = lingerMs;
  }

  /** The newest messages of a transcript; open chats get any change first. */
  view(path: string): ChatView {
    const f = this.feed(path);
    this.check(f, true);
    this.release(path, f);
    return f.reader.view();
  }

  /** Sends the chat now, then each change. Throws when the file cannot be read. */
  subscribe(path: string, send: ChatSend): () => void {
    const f = this.feed(path);
    try {
      this.check(f, true);
    } catch (e) {
      this.release(path, f);
      throw e;
    }
    send("chat", f.reader.view());
    f.peers.add(send);
    if (!f.poll) {
      this.watch(f);
      // A missed watch event (or a replaced file) is caught within a second.
      f.poll = setInterval(() => this.check(f), 1000);
      f.poll.unref();
    }
    return () => {
      f.peers.delete(send);
      this.release(path, f);
    };
  }

  private feed(path: string) {
    let f = this.feeds.get(path);
    if (!f)
      this.feeds.set(
        path,
        (f = { reader: new ConversationReader(path), peers: new Set() }),
      );
    clearTimeout(f.linger);
    return f;
  }

  private watch(f: Feed) {
    f.watcher?.close();
    try {
      // kqueue on macOS: the event arrives within a millisecond of the write.
      f.watcher = watch(f.reader.path, () => {
        f.queued ??= setTimeout(() => {
          f.queued = undefined;
          this.check(f);
        }, 0);
      });
      f.watcher.on("error", () => f.watcher?.close());
      f.watcher.unref();
      // kqueue starts watching at the next poll of the event loop; one read after
      // that catches a write made in between.
      setImmediate(() => setImmediate(() => this.check(f)));
    } catch {
      f.watcher = undefined;
    }
  }

  private check(f: Feed, rethrow = false) {
    let r: ReturnType<ConversationReader["update"]>;
    try {
      r = f.reader.update();
    } catch (e) {
      if (rethrow) throw e;
      return;
    }
    if (r === "reset") {
      if (f.peers.size) this.watch(f);
      const view = f.reader.view();
      for (const send of f.peers) send("chat", view);
    } else if (r.messages.length)
      for (const send of f.peers) send("chat-delta", r);
  }

  private release(path: string, f: Feed) {
    if (f.peers.size) return;
    f.watcher?.close();
    clearInterval(f.poll);
    clearTimeout(f.queued);
    f.watcher = f.poll = f.queued = undefined;
    clearTimeout(f.linger);
    f.linger = setTimeout(() => this.feeds.delete(path), this.lingerMs);
    f.linger.unref();
  }
}
