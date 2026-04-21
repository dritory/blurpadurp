// RSS connector. Direct ingest from wire services and quality newsrooms.
// Complements GDELT: RSS gets us Reuters/AP/BBC wire content that GDELT's
// web crawler misses. One scope per feed, each with its own cursor.
//
// If a feed 403s, the scope's cursor does not advance and we silently
// move on. Feeds that stay broken for multiple runs should be removed
// from FEEDS below.

import Parser from "rss-parser";

import type {
  Connector,
  Cursor,
  NormalizedStoryInput,
  RawSourceItem,
} from "./types.ts";

const FEEDS: Record<string, string> = {
  bbc_world: "https://feeds.bbci.co.uk/news/world/rss.xml",
  bbc_business: "https://feeds.bbci.co.uk/news/business/rss.xml",
  guardian_world: "https://www.theguardian.com/world/rss",
  npr_news: "https://feeds.npr.org/1001/rss.xml",
  aljazeera: "https://www.aljazeera.com/xml/rss/all.xml",
  france24_en: "https://www.france24.com/en/rss",
  dw_en: "https://rss.dw.com/rdf/rss-en-all",
  nyt_home: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
  // reuters_world — public Reuters RSS deprecated (406). Wire content
  // only reaches us via GDELT syndication links.
  // ap_top — URL returns 404; AP public RSS is unreliable.
  ft_home: "https://www.ft.com/rss/home",
  politico: "https://www.politico.com/rss/politicopicks.xml",
  axios_news: "https://www.axios.com/feeds/feed.rss",
  japantimes_news: "https://www.japantimes.co.jp/feed/",
  jpost: "https://www.jpost.com/rss/rssfeedsheadlines.aspx",
  scmp_world: "https://www.scmp.com/rss/91/feed",
  // nature_news — 406, Accept-header sensitive. Revisit if sci coverage
  // matters more.
  economist_world: "https://www.economist.com/international/rss.xml",
  // semafor — 404, no public feed found.
  propublica: "https://feeds.propublica.org/propublica/main",
};

const PARSER = new Parser({
  timeout: 10_000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (compatible; Blurpadurp/0.1; +https://blurpadurp.com)",
  },
});

// Drop RSS items whose pubDate is older than this, and items with no
// pubDate at all. Quality feeds always date their items; a missing date
// usually means evergreen or archive content (e.g. the Economist mixes
// reprints from prior years into its RSS). A 30-day window gives enough
// slack for mid-pipeline delays without admitting actual archive items.
const MAX_RSS_AGE_MS = 30 * 24 * 3600_000;

interface RssRaw {
  outlet: string;
  title: string;
  summary: string | null;
  link: string;
  guid: string;
  published_at: Date | null;
}

export const rss: Connector = {
  name: "rss",

  scopes(): string[] {
    return Object.keys(FEEDS);
  },

  async fetchSince(cursor: Cursor): Promise<RawSourceItem[]> {
    const scope = cursor.scope_key ?? "";
    const url = FEEDS[scope];
    if (!url) {
      throw new Error(`rss: unknown scope "${scope}"`);
    }

    let feed: Awaited<ReturnType<typeof PARSER.parseURL>>;
    try {
      feed = await PARSER.parseURL(url);
    } catch (e) {
      console.warn(
        `[rss] ${scope} fetch failed: ${e instanceof Error ? e.message : e}`,
      );
      return [];
    }

    const minMs = cursor.last_seen_at?.getTime() ?? 0;
    const ageFloorMs = Date.now() - MAX_RSS_AGE_MS;
    const fetched_at = new Date();
    let droppedNoDate = 0;
    let droppedTooOld = 0;

    const items = feed.items
      .filter((i) => typeof i.link === "string" && i.link.length > 0)
      .filter((i) => {
        const d = i.pubDate ? safeDate(i.pubDate) : null;
        if (d === null) {
          droppedNoDate++;
          return false;
        }
        const t = d.getTime();
        if (t < ageFloorMs) {
          droppedTooOld++;
          return false;
        }
        return t > minMs;
      })
      .map((i) => {
        const raw: RssRaw = {
          outlet: scope,
          title: (i.title ?? "").trim(),
          summary: stripHtml(i.contentSnippet ?? i.content ?? null),
          link: i.link!,
          guid: i.guid ?? i.link!,
          published_at: i.pubDate ? safeDate(i.pubDate) : null,
        };
        return {
          source_event_id: raw.guid,
          fetched_at,
          raw,
        };
      });

    if (droppedNoDate > 0 || droppedTooOld > 0) {
      console.log(
        `[rss] ${scope}: dropped ${droppedNoDate} no-date, ${droppedTooOld} too-old`,
      );
    }
    return items;
  },

  normalize(item: RawSourceItem): NormalizedStoryInput {
    const r = item.raw as RssRaw;
    return {
      source_name: "rss",
      source_event_id: r.guid,
      source_url: r.link,
      title: r.title,
      summary: r.summary,
      published_at: r.published_at,
    };
  },
};

function stripHtml(s: string | null): string | null {
  if (!s) return null;
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000) || null;
}

function safeDate(s: string): Date | null {
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}
