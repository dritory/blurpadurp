import { describe, expect, test } from "bun:test";
import {
  computeRange,
  decodeHtmlEntities,
  dedupByCanonicalUrl,
  extractTitle,
  gdelt,
  parseSqlDate,
  rerankByTier1,
} from "./gdelt.ts";
import type { RawSourceItem } from "./types.ts";

// EventRow-shaped factory (structural; the internal type isn't exported).
function ev(p: {
  id: string;
  url: string;
  mentions: number;
  urls?: string[];
}) {
  return {
    global_event_id: p.id,
    canonical_url: p.url,
    num_mentions: p.mentions,
    avg_tone: 0,
    event_root_code: null,
    event_code: null,
    actor1_name: null,
    actor2_name: null,
    sqldate: 20260601,
    all_urls: p.urls ?? [p.url],
  };
}

describe("parseSqlDate", () => {
  test("parses an 8-digit YYYYMMDD into a UTC date", () => {
    expect(parseSqlDate(20260601)?.toISOString()).toBe(
      "2026-06-01T00:00:00.000Z",
    );
  });
  test("rejects wrong length or zero components", () => {
    expect(parseSqlDate(2026)).toBeNull();
    expect(parseSqlDate(20260001)).toBeNull(); // month 0
  });
});

describe("decodeHtmlEntities", () => {
  test("decodes named, decimal, and hex entities", () => {
    expect(decodeHtmlEntities("AT&amp;T &#38; &#x26; &quot;q&quot;")).toBe(
      'AT&T & & "q"',
    );
  });
});

describe("extractTitle", () => {
  test("prefers og:title (either attribute order)", () => {
    expect(
      extractTitle('<meta property="og:title" content="OG Headline"><title>t</title>'),
    ).toBe("OG Headline");
    expect(
      extractTitle('<meta content="OG Second" property="og:title">'),
    ).toBe("OG Second");
  });
  test("falls back to <title>, decodes entities, null when absent", () => {
    expect(extractTitle("<title>Tom &amp; Jerry</title>")).toBe("Tom & Jerry");
    expect(extractTitle("<p>no title here</p>")).toBeNull();
  });
});

describe("computeRange", () => {
  test("floors start to UTC midnight", () => {
    const { start, end } = computeRange(new Date());
    expect(start.getUTCHours()).toBe(0);
    expect(start.getUTCMinutes()).toBe(0);
    expect(start.getUTCSeconds()).toBe(0);
    expect(start.getUTCMilliseconds()).toBe(0);
    expect(end.getTime()).toBeGreaterThanOrEqual(start.getTime());
  });
  test("null cursor looks back ~24h (start on the prior day's partition)", () => {
    const { start } = computeRange(null);
    const expectedDay = new Date(Date.now() - 24 * 3600_000);
    expect(start.getUTCDate()).toBe(expectedDay.getUTCDate());
  });
});

describe("dedupByCanonicalUrl", () => {
  test("collapses same canonical url, keeps max mentions, unions urls", () => {
    const out = dedupByCanonicalUrl([
      ev({ id: "1", url: "https://a.com/x", mentions: 30, urls: ["https://a.com/x", "https://m1"] }),
      ev({ id: "2", url: "https://a.com/x", mentions: 50, urls: ["https://m2"] }),
      ev({ id: "3", url: "https://b.com/y", mentions: 25 }),
    ]);
    expect(out).toHaveLength(2);
    const a = out.find((r) => r.canonical_url === "https://a.com/x")!;
    expect(a.num_mentions).toBe(50); // representative = highest mentions
    expect(new Set(a.all_urls)).toEqual(
      new Set(["https://a.com/x", "https://m1", "https://m2"]),
    );
  });
});

describe("rerankByTier1", () => {
  test("ranks events with more tier-1 sources first and promotes the tier-1 url", () => {
    const out = rerankByTier1([
      ev({ id: "1", url: "https://regional.example/x", mentions: 100 }),
      ev({
        id: "2",
        url: "https://regional2.example/y",
        mentions: 10,
        urls: ["https://regional2.example/y", "https://reuters.com/y"],
      }),
    ]);
    // Event 2 has a tier-1 source despite far fewer mentions → ranked first.
    expect(out[0]!.global_event_id).toBe("2");
    // canonical promoted to the tier-1 url.
    expect(out[0]!.canonical_url).toBe("https://reuters.com/y");
  });
});

describe("gdelt.normalize", () => {
  test("excludes the canonical url from additional and carries metadata", () => {
    const item: RawSourceItem = {
      source_event_id: "evt",
      fetched_at: new Date(),
      raw: {
        ...ev({
          id: "G1",
          url: "https://reuters.com/x",
          mentions: 42,
          urls: ["https://reuters.com/x", "https://m1", "https://m2"],
        }),
        title: "A headline",
        published_at: new Date("2026-06-01T00:00:00.000Z"),
      },
    };
    const n = gdelt.normalize(item);
    expect(n.source_event_id).toBe("https://reuters.com/x");
    expect(n.additional_source_urls).toEqual(["https://m1", "https://m2"]);
    expect(n.gdelt_metadata?.event_id).toBe("G1");
    expect(n.gdelt_metadata?.source_count).toBe(42);
  });
});
