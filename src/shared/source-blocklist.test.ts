import { describe, expect, test } from "bun:test";
import {
  extractHost,
  isHostBlocked,
  normalizeHost,
} from "./source-blocklist.ts";

describe("normalizeHost", () => {
  test("lowercases, strips leading www. and trailing dots", () => {
    expect(normalizeHost("WWW.Example.COM.")).toBe("example.com");
    expect(normalizeHost("  News.Site.org  ")).toBe("news.site.org");
  });
});

describe("extractHost", () => {
  test("pulls the normalized host from an http(s) url", () => {
    expect(extractHost("https://www.nypost.com/2026/x")).toBe("nypost.com");
  });

  test("returns null for non-http schemes, relative paths, and nullish", () => {
    expect(extractHost("ftp://example.com")).toBeNull();
    expect(extractHost("/relative/path")).toBeNull();
    expect(extractHost(null)).toBeNull();
    expect(extractHost(undefined)).toBeNull();
  });
});

describe("isHostBlocked (subdomain rollup + TLD guard)", () => {
  const set = new Set(["nypost.com", "foo.co.uk"]);

  test("blocks the exact host", () => {
    expect(isHostBlocked("nypost.com", set)).toBe(true);
  });

  test("blocks subdomains of a blocked host", () => {
    expect(isHostBlocked("video.nypost.com", set)).toBe(true);
    expect(isHostBlocked("www.nypost.com", set)).toBe(true); // www normalized away
  });

  test("does not block an unrelated host", () => {
    expect(isHostBlocked("reuters.com", set)).toBe(false);
  });

  test("TLD guard: a bare TLD entry never nukes everything", () => {
    // Even if 'com' somehow ends up in the set, it must not match foo.com.
    expect(isHostBlocked("anything.com", new Set(["com"]))).toBe(false);
  });

  test("two-label blocked host still matches itself", () => {
    expect(isHostBlocked("foo.co.uk", set)).toBe(true);
    expect(isHostBlocked("a.foo.co.uk", set)).toBe(true);
  });
});
