import { describe, expect, test } from "bun:test";

import {
  buildManifest,
  MANIFEST_VERSION,
  normalizeRequestPath,
  type StaticEntry,
} from "./static-manifest.ts";

// The Worker's own resolver, imported directly. `routes.ts` is kept free
// of Cloudflare types precisely so this import works: the guard is worth
// more than the tidiness of keeping the two trees apart. Before the
// manifest, the equivalent test read the Worker's source with a regex and
// could only check the locale prefix list.
import {
  lookupRoute,
  normalizeRequestPath as workerNormalize,
  parseManifest,
  SUPPORTED_MANIFEST_VERSION,
} from "../../infra/worker/src/routes.ts";

function entry(path: string, key: string): StaticEntry {
  return { path, key, contentType: "text/html; charset=utf-8", ttl: 60 };
}

describe("normalizeRequestPath", () => {
  test("collapses trailing slashes but keeps the root", () => {
    expect(normalizeRequestPath("/")).toBe("/");
    expect(normalizeRequestPath("")).toBe("/");
    expect(normalizeRequestPath("/archive")).toBe("/archive");
    expect(normalizeRequestPath("/archive/")).toBe("/archive");
    expect(normalizeRequestPath("/no/")).toBe("/no");
    expect(normalizeRequestPath("/issue/12/")).toBe("/issue/12");
  });

  test("the Worker normalises identically", () => {
    // If these diverge, "/archive/" resolves at one end and not the
    // other — a whole page quietly falling through to the origin.
    for (const path of [
      "",
      "/",
      "/archive",
      "/archive/",
      "/no",
      "/no/",
      "/no/archive/",
      "/issue/12",
      "/issue/12/",
      "/assets/blurp.svg",
      "/feed.xml",
      "//",
      "/a//b/",
    ]) {
      expect(workerNormalize(path)).toBe(normalizeRequestPath(path));
    }
  });
});

describe("buildManifest", () => {
  test("keys routes by normalised path", () => {
    const m = buildManifest([entry("/archive/", "archive.html")], new Date(0));
    expect(m.routes["/archive"]).toBeDefined();
    expect(m.routes["/archive/"]).toBeUndefined();
  });

  test("later entries win, which is how the favicon alias works", () => {
    const m = buildManifest(
      [
        { ...entry("/favicon.ico", "assets/wrong.svg"), ttl: 1 },
        { ...entry("/favicon.ico", "assets/blurp.svg"), ttl: 2 },
      ],
      new Date(0),
    );
    expect(m.routes["/favicon.ico"]?.key).toBe("assets/blurp.svg");
  });

  test("declares the version the Worker accepts", () => {
    expect(MANIFEST_VERSION).toBe(SUPPORTED_MANIFEST_VERSION);
  });
});

describe("the Worker resolves what the export publishes", () => {
  // The point of the whole exercise: a manifest built by the app is
  // consumed by the Worker's real code path, serialised through JSON
  // exactly as it travels through R2.
  function roundTrip(entries: StaticEntry[]) {
    const manifest = buildManifest(entries, new Date(0));
    const parsed = parseManifest(JSON.stringify(manifest));
    expect(parsed).not.toBeNull();
    return parsed;
  }

  test("a published path resolves to its object, with type and ttl", () => {
    const parsed = roundTrip([
      { path: "/no/archive", key: "no/archive.html", contentType: "text/html", ttl: 60 },
    ]);
    const route = lookupRoute(parsed, "/no/archive");
    expect(route).toEqual({
      key: "no/archive.html",
      contentType: "text/html",
      ttl: 60,
    });
  });

  test("trailing slash still resolves", () => {
    const parsed = roundTrip([entry("/archive", "archive.html")]);
    expect(lookupRoute(parsed, "/archive/")?.key).toBe("archive.html");
  });

  test("an unpublished path falls through to the origin", () => {
    const parsed = roundTrip([entry("/", "home.html")]);
    expect(lookupRoute(parsed, "/admin/review")).toBeNull();
    expect(lookupRoute(parsed, "/subscribe")).toBeNull();
    // An issue the export hasn't written yet: origin renders it.
    expect(lookupRoute(parsed, "/issue/999")).toBeNull();
  });

  test("no manifest means everything proxies — Tier 0, not a 404", () => {
    expect(lookupRoute(null, "/")).toBeNull();
    expect(lookupRoute(null, "/archive")).toBeNull();
  });
});

describe("parseManifest rejects what it shouldn't trust", () => {
  test("malformed JSON, wrong shape, or a future version yield null", () => {
    expect(parseManifest("{ not json")).toBeNull();
    expect(parseManifest("null")).toBeNull();
    expect(parseManifest('"a string"')).toBeNull();
    expect(parseManifest(JSON.stringify({ version: 1 }))).toBeNull();
    expect(
      parseManifest(
        JSON.stringify({ version: 999, generatedAt: "", routes: {} }),
      ),
    ).toBeNull();
  });

  test("an entry with no key is a miss, not an undefined R2 read", () => {
    const parsed = parseManifest(
      JSON.stringify({
        version: MANIFEST_VERSION,
        generatedAt: "",
        routes: { "/": { contentType: "text/html", ttl: 60 } },
      }),
    );
    expect(lookupRoute(parsed, "/")).toBeNull();
  });

  test("a missing content type or ttl falls back rather than throwing", () => {
    const parsed = parseManifest(
      JSON.stringify({
        version: MANIFEST_VERSION,
        generatedAt: "",
        routes: { "/": { key: "home.html" } },
      }),
    );
    expect(lookupRoute(parsed, "/")).toEqual({
      key: "home.html",
      contentType: "application/octet-stream",
      ttl: 60,
    });
  });
});
