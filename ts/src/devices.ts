/** Phones paired with this Mac. Each device has its own token; the file keeps only
 *  a hash, so a copy of it cannot be used to sign in. */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { monitorDir } from "./monitor.ts";

interface Device {
  id: string;
  name: string;
  hash: string;
  created: number;
  seen: number;
}
interface Store {
  /** Tailnet name the phone uses, e.g. mac.tail1234.ts.net. */
  host?: string;
  devices: Device[];
}

const CODE_MS = 5 * 60 * 1000,
  CODE_TRIES = 5,
  ATTEMPTS_PER_MINUTE = 10,
  SEEN_WRITE_MS = 60 * 1000;
const sha = (token: string) => createHash("sha256").update(token).digest();

export class Devices {
  now = () => Date.now();
  private pairing?: { code: string; expires: number; tries: number };
  private attempts: number[] = [];

  constructor(private file = join(monitorDir(), "devices.json")) {}

  /** Read on every call: the file is small, and a revoke takes effect at once. */
  private load(): Store {
    try {
      const s = JSON.parse(readFileSync(this.file, "utf8"));
      return { host: s.host, devices: Array.isArray(s.devices) ? s.devices : [] };
    } catch {
      return { devices: [] };
    }
  }
  private save(s: Store) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify(s, null, 2), { mode: 0o600 });
  }

  host() {
    return this.load().host;
  }
  setHost(host: string) {
    this.save({ ...this.load(), host: host.toLowerCase() });
  }

  list() {
    return this.load().devices.map(({ id, name, created, seen }) => ({
      id,
      name,
      created,
      seen,
    }));
  }

  /** A new code replaces any earlier one. */
  startPairing() {
    this.pairing = {
      code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
      expires: this.now() + CODE_MS,
      tries: 0,
    };
    return { code: this.pairing.code, expires: this.pairing.expires };
  }

  /** Counts every attempt, right or wrong, for the per-minute limit. */
  limited() {
    const now = this.now();
    this.attempts = this.attempts.filter((t) => now - t < 60_000);
    this.attempts.push(now);
    return this.attempts.length > ATTEMPTS_PER_MINUTE;
  }

  pair(code: unknown, name: unknown) {
    const p = this.pairing;
    if (!p || p.expires < this.now()) {
      this.pairing = undefined;
      throw new Error("This code is not valid. Make a new one on the Mac");
    }
    if (typeof code !== "string" || code !== p.code) {
      if (++p.tries >= CODE_TRIES) this.pairing = undefined;
      throw new Error("This code is not valid. Make a new one on the Mac");
    }
    this.pairing = undefined;
    const token = randomBytes(32).toString("hex"),
      device: Device = {
        id: randomBytes(8).toString("hex"),
        name: (typeof name === "string" && name.trim().slice(0, 60)) || "iPhone",
        hash: sha(token).toString("hex"),
        created: this.now(),
        seen: this.now(),
      },
      s = this.load();
    s.devices.push(device);
    this.save(s);
    return { id: device.id, token };
  }

  check(token: string) {
    const want = sha(token),
      s = this.load(),
      d = s.devices.find((d) => {
        const have = Buffer.from(d.hash, "hex");
        return have.length === want.length && timingSafeEqual(have, want);
      });
    if (d && this.now() - d.seen > SEEN_WRITE_MS) {
      d.seen = this.now();
      this.save(s);
    }
    return d;
  }

  revoke(id: unknown) {
    const s = this.load();
    this.save({ ...s, devices: s.devices.filter((d) => d.id !== id) });
  }
}

/** This Mac's tailnet name, if Tailscale runs here. */
export function tailscaleHost(): string | undefined {
  const bins = [
    process.env["CFIND_TAILSCALE_BIN"],
    "tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ].filter(Boolean) as string[];
  for (const bin of bins)
    try {
      const out = execFileSync(bin, ["status", "--json"], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const name = JSON.parse(out)?.Self?.DNSName;
      if (typeof name === "string" && name) return name.replace(/\.$/, "");
    } catch {}
  return undefined;
}
