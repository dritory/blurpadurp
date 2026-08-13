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
      // Locale-agnostic: exactly one of each, at the bare key.
      "feed.xml",
      "sitemap.xml",
      "robots.txt",
      // Default locale keeps the bare keys, so nothing at the edge moved.
      "home.html",
      "archive.html",
      "about.html",
      "privacy.html",
      "issues/1.html",
      "issues/2.html",
      // Norwegian is namespaced under its URL prefix. These MUST match
      // the Worker's pageTarget() mapping in infra/worker/src/index.ts.
      "no/home.html",
      "no/archive.html",
      "no/about.html",
      "no/privacy.html",
      "no/issues/1.html",
      "no/issues/2.html",
    ]) {
      expect(keys.has(k)).toBe(true);
    }
    // 3 locale-agnostic + (4 pages + 2 issues) per locale × 2 locales.
    expect(objs.length).toBe(15);
    // Every key is distinct — a collision would mean one locale
    // silently overwriting the other in R2.
    expect(keys.size).toBe(objs.length);
  });

  test("a locale's page is in its own language, not the default", async () => {
    const objs = byKey(await renderStaticSurface([issue(2, new Date())], 8));
    expect(objs.get("home.html")).toContain('lang="en"');
    expect(objs.get("no/home.html")).toContain('lang="nb"');
    // Nav is translated…
    expect(objs.get("no/archive.html")).toContain("Arkiv");
    // …and links stay inside the locale rather than dumping the reader
    // back onto the English site.
    expect(objs.get("no/archive.html")).toContain('href="/no/issue/2"');
    // …but the brief body is the composer's English prose either way.
    expect(objs.get("no/issues/2.html")).toContain(`${UNIQUE}-2`);
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
    expect(keys.has("no/home.html")).toBe(true);
    expect([...keys].some((k) => /(^|\/)issues\//.test(k))).toBe(false);
    // 3 locale-agnostic + 4 pages per locale × 2 locales.
    expect(objs.length).toBe(11);
  });

  test("the sitemap enumerates every locale of every page", async () => {
    const objs = byKey(await renderStaticSurface([issue(2, new Date())], 8));
    const sitemap = objs.get("sitemap.xml")!;
    // Base URL comes from the environment and varies across the shared
    // test process, so match on the path suffix of each <loc>.
    const locs = [...sitemap.matchAll(/<loc>[^<]*?((?:\/[^<]*)?)<\/loc>/g)].map(
      (m) => m[0].replace(/<\/?loc>/g, ""),
    );
    const paths = locs.map((l) => l.replace(/^https?:\/\/[^/]+/, "") || "/");
    for (const path of ["/", "/archive", "/about", "/privacy", "/issue/2"]) {
      expect(paths).toContain(path);
      expect(paths).toContain(path === "/" ? "/no" : `/no${path}`);
    }
  });
});

describe("Worker key map", () => {
  // The export writes R2 keys and the Worker reads them; nothing at
  // runtime connects the two, so a locale added on one side and not the
  // other means /no/* quietly proxies to Fly (or 404s) forever. The
  // Worker isn't importable here — it's a separate build with
  // Cloudflare-only types — so the guard reads its source.
  test("the Worker's locale prefixes match LOCALE_PREFIX", async () => {
    const { LOCALES, LOCALE_PREFIX } = await import("../shared/i18n.ts");
    const src = await Bun.file("infra/worker/src/index.ts").text();
    const m = src.match(/const LOCALE_PREFIXES = \[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const workerPrefixes = [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    const appPrefixes = LOCALES.map((l) => LOCALE_PREFIX[l]).filter(
      (p) => p !== "",
    );
    expect(workerPrefixes.sort()).toEqual(appPrefixes.sort());
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
