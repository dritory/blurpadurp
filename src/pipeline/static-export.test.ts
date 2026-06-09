import { describe, expect, test } from "bun:test";
// Type-only import is erased at runtime — it does NOT pull in ../db.
import type { IssueRow, RenderedObject } from "./static-export.tsx";

// static-export.tsx transitively imports ../db/index.ts, whose
// top-level `new pg.Pool({ connectionString: getEnv("DATABASE_URL") })`
// requires the var to exist (it does NOT connect until a query, which
// these pure-render tests never issue). Provide a dummy before the
// dynamic import so the suite runs without a database.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BLURPADURP_PUBLIC_URL ??= "https://example.test";

import {
  makeMemoryObjectStore,
  setPublicObjectStoreForTesting,
} from "../shared/object-store.ts";

const { renderStaticSurface, exportPublicAssets } = await import(
  "./static-export.tsx"
);

const UNIQUE = "UNIQUE_BODY_MARKER_4F2";

function issue(id: number, publishedAt: Date): IssueRow {
  return {
    id,
    publishedSeq: id,
    publishedAt,
    isEventDriven: false,
    title: `Issue ${id}`,
    html: `<p>${UNIQUE}-${id}</p>`,
  };
}

function byKey(objs: RenderedObject[]): Map<string, string> {
  return new Map(objs.map((o) => [o.key, o.body]));
}

describe("renderStaticSurface", () => {
  test("emits the full rolling+permalink key set, keys match the Worker", async () => {
    const now = new Date();
    const objs = await renderStaticSurface(
      [issue(2, now), issue(1, new Date(now.getTime() - 86_400_000))],
      8,
    );
    const keys = new Set(objs.map((o) => o.key));
    for (const k of [
      "home.html",
      "archive.html",
      "about.html",
      "privacy.html",
      "feed.xml",
      "sitemap.xml",
      "robots.txt",
      "issues/1.html",
      "issues/2.html",
    ]) {
      expect(keys.has(k)).toBe(true);
    }
    // No stray keys beyond the rolling 7 + one per issue.
    expect(objs.length).toBe(9);
  });

  test("fresh latest issue renders into home + its permalink + feed", async () => {
    const objs = byKey(await renderStaticSurface([issue(2, new Date())], 8));
    expect(objs.get("home.html")).toContain(`${UNIQUE}-2`);
    expect(objs.get("issues/2.html")).toContain(`${UNIQUE}-2`);
    // Feed embeds escaped content html; the marker has no special chars.
    expect(objs.get("feed.xml")).toContain(`${UNIQUE}-2`);
    expect(objs.get("sitemap.xml")).toContain("/issue/2");
  });

  test("a stale latest issue makes home go silent (body not inlined)", async () => {
    const old = new Date(Date.now() - 30 * 86_400_000);
    const objs = byKey(await renderStaticSurface([issue(5, old)], 8));
    // Silence panel deep-links the back issue but does not inline its body.
    expect(objs.get("home.html")).not.toContain(`${UNIQUE}-5`);
    // The permalink still carries the full issue.
    expect(objs.get("issues/5.html")).toContain(`${UNIQUE}-5`);
  });

  test("no issues → rolling pages only, empty home, no permalinks", async () => {
    const objs = await renderStaticSurface([], 8);
    const keys = new Set(objs.map((o) => o.key));
    expect(keys.has("home.html")).toBe(true);
    expect([...keys].some((k) => k.startsWith("issues/"))).toBe(false);
    expect(objs.length).toBe(7);
  });
});

describe("exportPublicAssets", () => {
  test("mirrors ./public to the store under assets/ keys", async () => {
    const store = makeMemoryObjectStore();
    setPublicObjectStoreForTesting(store);
    try {
      const n = await exportPublicAssets();
      expect(n).toBeGreaterThan(0);
      // The page sub-resources that were leaking to Fly:
      expect(await store.exists("assets/blurp.svg")).toBe(true);
      expect(await store.exists("assets/wave.js")).toBe(true);
      // Nested dirs keep their path (slash-joined, not OS sep).
      expect(await store.exists("assets/vendor/htmx-2.0.4.min.js")).toBe(true);
    } finally {
      setPublicObjectStoreForTesting(null);
    }
  });
});
