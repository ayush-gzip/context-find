/**
 * Local results immediately, remote hosts folded in as they answer.
 *
 * A sleeping machine costs an ssh timeout. Waiting for that before drawing
 * anything makes the tool look hung, so each host resolves independently and
 * the interface is told to redraw when one lands.
 */
import { searchLocalTranscripts, type Session } from "./store.ts";
import { hostDisplayName, searchRemoteTranscripts } from "./remote.ts";
import { debug } from "./debug.ts";

type HostError = [host: string, message: string];

export class Search {
  sessions: Session[];
  errors: HostError[] = [];
  pending: string[];
  private readonly done: Promise<void>;
  private listeners: (() => void)[] = [];

  constructor(query = "", hosts: string[] = [], onUpdate: () => void = () => {}) {
    this.sessions = searchLocalTranscripts(query);
    this.pending = hosts.map(hostDisplayName);
    if (onUpdate) this.listeners.push(onUpdate);
    debug(`search started: ${this.sessions.length} local results, ${hosts.length} remote hosts`);

    this.done = Promise.all(
      hosts.map(async (spec) => {
        const label = hostDisplayName(spec);
        try {
          const rows = await searchRemoteTranscripts(spec, query);
          this.sessions = [...this.sessions, ...rows].sort((a, b) => b.mtime - a.mtime);
          debug(`${label}: remote search returned ${rows.length} results`);
        } catch (error) {
          // one unreachable host must not fail the run
          this.errors = [...this.errors, [label, (error as Error).message]];
          debug(`${label}: remote search failed`);
        } finally {
          this.pending = this.pending.filter((name) => name !== label);
          this.notify();
        }
      }),
    ).then(() => {
      debug(`remote searches completed: ${hosts.length - this.errors.length} succeeded, ${this.errors.length} failed`);
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* ignore error from listener */
      }
    }
  }

  wait(): Promise<void> {
    return this.done;
  }
}
