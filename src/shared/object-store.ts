// Cold-storage object store. The persist-forever payloads
// (ai_call_log input/output, and later story.raw_input/raw_output) are
// read approximately never on the hot path, so they live in object
// storage (Cloudflare R2) rather than burning Neon's 500 MB free-tier
// budget. Postgres keeps the scalar columns + an object key.
// See docs/storage.md.
//
// Three backends behind one interface:
//   - "r2":     Cloudflare R2 via Bun's built-in S3 client (no dep).
//   - "fs":     local directory — dev, and the substrate for tests.
//   - "memory": in-process map — tests only.
//
// The backend is chosen by BLURPADURP_STORAGE_BACKEND (default: "r2"
// when R2 creds are present, else "fs" under ./.cold-storage). Whether
// the pipeline actually offloads is a *separate* switch — the
// `storage.cold_tier` config flag — so the store can be exercised in
// dev without changing production behavior.

import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getEnv } from "./env.ts";

export interface ObjectStore {
  readonly backend: string;
  put(key: string, body: string): Promise<void>;
  // Returns null when the key is absent (vs. throwing on transport
  // errors) so callers can fall back to an inline jsonb column.
  get(key: string): Promise<string | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

class MemoryObjectStore implements ObjectStore {
  readonly backend = "memory";
  private readonly map = new Map<string, string>();
  async put(key: string, body: string): Promise<void> {
    this.map.set(key, body);
  }
  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  async exists(key: string): Promise<boolean> {
    return this.map.has(key);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

class FsObjectStore implements ObjectStore {
  readonly backend = "fs";
  constructor(private readonly root: string) {}
  private path(key: string): string {
    // Guard against path traversal — keys are app-generated, but cheap
    // to enforce: the resolved path must stay under root.
    const p = resolve(this.root, key);
    if (p !== this.root && !p.startsWith(this.root + "/")) {
      throw new Error(`object-store: key escapes root: ${key}`);
    }
    return p;
  }
  async put(key: string, body: string): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await Bun.write(p, body);
  }
  async get(key: string): Promise<string | null> {
    const f = Bun.file(this.path(key));
    if (!(await f.exists())) return null;
    return f.text();
  }
  async exists(key: string): Promise<boolean> {
    return Bun.file(this.path(key)).exists();
  }
  async delete(key: string): Promise<void> {
    await Bun.file(this.path(key)).delete().catch(() => {});
  }
}

class R2ObjectStore implements ObjectStore {
  readonly backend = "r2";
  // Lazily constructed so importing this module never requires R2 creds
  // (e.g. when the cold tier is off, or in tests).
  private client: import("bun").S3Client | null = null;
  private getClient(): import("bun").S3Client {
    if (this.client === null) {
      // Bun.S3Client is S3-compatible; R2's endpoint is
      // https://<accountid>.r2.cloudflarestorage.com
      const { S3Client } = require("bun") as typeof import("bun");
      this.client = new S3Client({
        accessKeyId: getEnv("R2_ACCESS_KEY_ID"),
        secretAccessKey: getEnv("R2_SECRET_ACCESS_KEY"),
        bucket: getEnv("R2_BUCKET"),
        endpoint: getEnv("R2_ENDPOINT"),
        region: "auto",
      });
    }
    return this.client;
  }
  async put(key: string, body: string): Promise<void> {
    await this.getClient().write(key, body, {
      type: "application/json",
    });
  }
  async get(key: string): Promise<string | null> {
    const f = this.getClient().file(key);
    if (!(await f.exists())) return null;
    return f.text();
  }
  async exists(key: string): Promise<boolean> {
    return this.getClient().file(key).exists();
  }
  async delete(key: string): Promise<void> {
    await this.getClient().delete(key);
  }
}

let singleton: ObjectStore | null = null;

export function getObjectStore(): ObjectStore {
  if (singleton !== null) return singleton;
  singleton = buildObjectStore();
  return singleton;
}

// Test seam: swap in a memory/fs store without env juggling.
export function setObjectStoreForTesting(store: ObjectStore | null): void {
  singleton = store;
}

export function makeMemoryObjectStore(): ObjectStore {
  return new MemoryObjectStore();
}

export function makeFsObjectStore(root: string): ObjectStore {
  return new FsObjectStore(resolve(root));
}

function buildObjectStore(): ObjectStore {
  const explicit = process.env.BLURPADURP_STORAGE_BACKEND;
  const hasR2Creds =
    !!process.env.R2_ACCESS_KEY_ID &&
    !!process.env.R2_SECRET_ACCESS_KEY &&
    !!process.env.R2_BUCKET &&
    !!process.env.R2_ENDPOINT;

  const backend = explicit ?? (hasR2Creds ? "r2" : "fs");
  switch (backend) {
    case "r2":
      return new R2ObjectStore();
    case "memory":
      return new MemoryObjectStore();
    case "fs":
      return new FsObjectStore(
        resolve(process.env.BLURPADURP_STORAGE_FS_DIR ?? ".cold-storage"),
      );
    default:
      throw new Error(`object-store: unknown backend "${backend}"`);
  }
}

// Content-addressed-ish key for an ai_call_log payload. Not used for
// dedup (scorer inputs are near-unique); the random suffix just keeps
// keys collision-free and groups them by stage + month for cheap
// lifecycle rules / browsing in the R2 console.
export function aiPayloadKey(stageName: string, when: Date = new Date()): string {
  const safeStage = stageName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const yyyy = when.getUTCFullYear();
  const mm = String(when.getUTCMonth() + 1).padStart(2, "0");
  return join("ai", safeStage, `${yyyy}`, mm, `${crypto.randomUUID()}.json`);
}

// Key for a story's raw_input/raw_output envelope. Grouped by month for
// the same lifecycle/browsing reasons as ai payloads.
export function storyPayloadKey(when: Date = new Date()): string {
  const yyyy = when.getUTCFullYear();
  const mm = String(when.getUTCMonth() + 1).padStart(2, "0");
  return join("story", `${yyyy}`, mm, `${crypto.randomUUID()}.json`);
}
