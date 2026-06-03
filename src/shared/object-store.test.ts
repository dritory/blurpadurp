import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aiPayloadKey,
  makeFsObjectStore,
  makeMemoryObjectStore,
  type ObjectStore,
} from "./object-store.ts";

const tmpDirs: string[] = [];
async function freshFsStore(): Promise<ObjectStore> {
  const dir = await mkdtemp(join(tmpdir(), "blurp-cold-"));
  tmpDirs.push(dir);
  return makeFsObjectStore(dir);
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

// Both backends are exercised against the same contract so the fs
// store (used in tests + dev) is a faithful stand-in for R2 on the
// hot path's behaviour.
function contract(name: string, make: () => Promise<ObjectStore> | ObjectStore) {
  describe(name, () => {
    test("round-trips a payload", async () => {
      const s = await make();
      const key = aiPayloadKey("scorer");
      await s.put(key, JSON.stringify({ input: { a: 1 }, output: { b: 2 } }));
      const got = await s.get(key);
      expect(got).not.toBeNull();
      expect(JSON.parse(got!)).toEqual({ input: { a: 1 }, output: { b: 2 } });
    });

    test("get returns null for a missing key (not throw)", async () => {
      const s = await make();
      expect(await s.get("ai/scorer/2026/01/does-not-exist.json")).toBeNull();
    });

    test("exists reflects presence", async () => {
      const s = await make();
      const key = aiPayloadKey("editor");
      expect(await s.exists(key)).toBe(false);
      await s.put(key, "x");
      expect(await s.exists(key)).toBe(true);
    });

    test("delete removes the object", async () => {
      const s = await make();
      const key = aiPayloadKey("composer");
      await s.put(key, "x");
      await s.delete(key);
      expect(await s.exists(key)).toBe(false);
    });

    test("nested keys with subdirectories work", async () => {
      const s = await make();
      const key = "ai/theme_confirm/2026/06/nested.json";
      await s.put(key, "y");
      expect(await s.get(key)).toBe("y");
    });
  });
}

contract("MemoryObjectStore", () => makeMemoryObjectStore());
contract("FsObjectStore", () => freshFsStore());

describe("aiPayloadKey", () => {
  test("groups by stage and month, ends in .json, is unique", () => {
    const when = new Date(Date.UTC(2026, 5, 2)); // June 2026
    const k1 = aiPayloadKey("scorer", when);
    const k2 = aiPayloadKey("scorer", when);
    expect(k1).toMatch(/^ai\/scorer\/2026\/06\/[0-9a-f-]+\.json$/);
    expect(k1).not.toBe(k2);
  });

  test("sanitizes stage names that contain path separators", () => {
    const k = aiPayloadKey("weird/stage name", new Date(Date.UTC(2026, 0, 1)));
    expect(k).toMatch(/^ai\/weird_stage_name\/2026\/01\//);
  });

  test("fs store rejects keys that escape the root", async () => {
    const s = await freshFsStore();
    await expect(s.put("../escape.json", "nope")).rejects.toThrow(/escape/);
  });
});
