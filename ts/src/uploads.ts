/** Images attached in the dashboard. Each is saved once under the data dir, so
 *  every route can hand the same file to an agent: as image data, as a local
 *  image item, or as a path in the text. */
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { monitorDir } from "./monitor.ts";

export const MAX_UPLOAD = 10 * 1024 * 1024,
  MAX_IMAGES = 4;
// Attached screenshots can hold private text, so they are not kept long.
const KEEP_MS = 7 * 24 * 3600 * 1000,
  ID = /^[0-9a-f]{32}\.(png|jpg|gif|webp)$/,
  TYPES: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };
const dir = () => join(monitorDir(), "uploads");

/** The bytes decide the type; the request header does not. */
function sniff(b: Buffer) {
  const ascii = (start: number, end: number) =>
    b.subarray(start, end).toString("latin1");
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
}

export function saveUpload(bytes: Buffer) {
  const ext = sniff(bytes);
  if (!ext) return undefined;
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  pruneUploads();
  const id = randomBytes(16).toString("hex") + "." + ext;
  writeFileSync(join(dir(), id), bytes, { mode: 0o600 });
  return id;
}

/** Removes images older than a week, or with `all` every image not in `keep`.
 *  Returns how many were removed. */
export function pruneUploads(all = false, keep = new Set<string>()) {
  let names: string[] = [],
    removed = 0;
  try {
    names = readdirSync(dir());
  } catch {}
  for (const name of names)
    try {
      if (keep.has(name)) continue;
      if (all || Date.now() - statSync(join(dir(), name)).mtimeMs > KEEP_MS) {
        rmSync(join(dir(), name), { force: true });
        removed++;
      }
    } catch {}
  return removed;
}

export function uploadStats() {
  let count = 0,
    bytes = 0;
  try {
    for (const name of readdirSync(dir()))
      try {
        bytes += statSync(join(dir(), name)).size;
        count++;
      } catch {}
  } catch {}
  return { count, bytes, keepDays: KEEP_MS / 86400000 };
}

export function uploadPath(id: unknown) {
  if (typeof id !== "string" || !ID.test(id)) throw new Error("Bad image id");
  const path = join(dir(), id);
  if (!existsSync(path)) throw new Error("Image not found");
  return path;
}

export const uploadType = (id: string) => TYPES[id.slice(id.indexOf(".") + 1)]!;

export function uploadIds(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGES)
    throw new Error(`Attach up to ${MAX_IMAGES} images`);
  value.forEach(uploadPath);
  return value;
}

/** Routes that only take text get each saved file's path; the agent opens it. */
export const withPaths = (text: string, ids: string[]) =>
  [text.trim(), ...ids.map((id) => `Image: ${uploadPath(id)}`)]
    .filter(Boolean)
    .join("\n");
