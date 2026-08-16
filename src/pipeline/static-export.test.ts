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

function byPath(objs: RenderedObject[]): Map<string, RenderedObject> {
  return new Map(objs.map((o) => [o.path, o]));
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
      // Norwegian is namespaced under its URL prefix. The Worker learns
      // these from the manifest rather than re-deriving them.
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

describe("every rendered page is reachable through the Worker", () => {
  // The export writes R2 keys and the Worker reads them. This used to be
  // two hand-written maps joined by a comment, and the guard here could
  // only regex the Worker's locale-prefix list out of its source. Now the
  // export publishes a manifest and the Worker resolves against it — so
  // the test can run the Worker's actual resolver over the actual output
  // and assert that every page the pipeline renders is served from the
  // edge rather than falling through to Fly.
  test("each page's public path resolves to that page's object", async () => {
    const { buildManifest } = await import("../shared/static-manifest.ts");
    const { lookupRoute, parseManifest } = await import(
      "../../infra/worker/src/routes.ts"
    );

    const objs = await renderStaticSurface([issue(2, new Date())], 8);
    // Serialised and re-parsed, exactly as it travels through R2.
    const manifest = parseManifest(
      JSON.stringify(buildManifest(objs, new Date())),
    );

    for (const obj of objs) {
      const route = lookupRoute(manifest, obj.path);
      expect(route, `${obj.path} does not resolve at the edge`).not.toBeNull();
      expect(route?.key).toBe(obj.key);
      expect(route?.contentType).toBe(obj.contentType);
    }
  });

  test("the localized paths are the ones readers actually visit", async () => {
    const { LOCALES, LOCALE_PREFIX } = await import("../shared/i18n.ts");
    const objs = byPath(await renderStaticSurface([issue(2, new Date())], 8));

    // Default locale is unprefixed; every other locale sits under its
    // prefix. A locale added to i18n.ts and not rendered here shows up as
    // a missing path, not as a silent proxy-to-Fly.
    for (const locale of LOCALES) {
      const prefix = LOCALE_PREFIX[locale];
      expect(objs.has(prefix === "" ? "/" : prefix)).toBe(true);
      for (const path of ["/archive", "/about", "/privacy", "/issue/2"]) {
        expect(objs.has(`${prefix}${path}`)).toBe(true);
      }
    }
    // Locale-agnostic surfaces stay at the bare path — exactly one each.
    for (const path of ["/feed.xml", "/sitemap.xml", "/robots.txt"]) {
      expect(objs.has(path)).toBe(true);
    }
  });

  test("issue permalinks cache harder than the rolling pages", async () => {
    const objs = byPath(await renderStaticSurface([issue(2, new Date())], 8));
    const permalink = objs.get("/issue/2")!;
    const home = objs.get("/")!;
    expect(permalink.ttl).toBeGreaterThan(home.ttl);
  });
});

describe("exportPublicAssets", () => {
  test("mirrors ./public to the store under assets/ keys", async () => {
    const store = makeMemoryObjectStore();
    setPublicObjectStoreForTesting(store);
    try {
      const entries = await exportPublicAssets();
      expect(entries.length).toBeGreaterThan(0);
      // The page sub-resources that were leaking to Fly:
      expect(await store.exists("assets/blurp.svg")).toBe(true);
      expect(await store.exists("assets/wave.js")).toBe(true);
      // Nested dirs keep their path (slash-joined, not OS sep).
      expect(await store.exists("assets/vendor/htmx-2.0.4.min.js")).toBe(true);
    } finally {
      setPublicObjectStoreForTesting(null);
    }
  });

  test("assets are advertised at their /assets/ URL, favicon aliased", async () => {
    const store = makeMemoryObjectStore();
    setPublicObjectStoreForTesting(store);
    try {
      const { lookupRoute, parseManifest } = await import(
        "../../infra/worker/src/routes.ts"
      );
      const { buildManifest } = await import("../shared/static-manifest.ts");
      const manifest = parseManifest(
        JSON.stringify(buildManifest(await exportPublicAssets(), new Date())),
      );

      // The sub-resource fetch that was waking Fly on every reader visit.
      expect(lookupRoute(manifest, "/assets/blurp.svg")).toEqual({
        key: "assets/blurp.svg",
        contentType: "image/svg+xml",
        ttl: 86_400,
      });
      expect(lookupRoute(manifest, "/assets/vendor/htmx-2.0.4.min.js")?.key).toBe(
        "assets/vendor/htmx-2.0.4.min.js",
      );
      // Crawlers probe /favicon.ico directly; it aliases onto the mark.
      expect(lookupRoute(manifest, "/favicon.ico")?.key).toBe(
        "assets/blurp.svg",
      );
      // Traversal isn't expressible: the manifest is an exact-match map,
      // so there's nothing to escape from.
      expect(lookupRoute(manifest, "/assets/../manifest.json")).toBeNull();
    } finally {
      setPublicObjectStoreForTesting(null);
    }
  });
});
