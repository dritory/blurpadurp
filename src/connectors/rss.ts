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
  // World / hard news
  bbc_world: "https://feeds.bbci.co.uk/news/world/rss.xml",
  bbc_business: "https://feeds.bbci.co.uk/news/business/rss.xml",
  guardian_world: "https://www.theguardian.com/world/rss",
  npr_news: "https://feeds.npr.org/1001/rss.xml",
  aljazeera: "https://www.aljazeera.com/xml/rss/all.xml",
  france24_en: "https://www.france24.com/en/rss",
  dw_en: "https://rss.dw.com/rdf/rss-en-all",
  nyt_home: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
  ft_home: "https://www.ft.com/rss/home",
  politico: "https://www.politico.com/rss/politicopicks.xml",
  axios_news: "https://www.axios.com/feeds/feed.rss",
  japantimes_news: "https://www.japantimes.co.jp/feed/",
  jpost: "https://www.jpost.com/rss/rssfeedsheadlines.aspx",
  scmp_world: "https://www.scmp.com/rss/91/feed",
  economist_world: "https://www.economist.com/international/rss.xml",
  propublica: "https://feeds.propublica.org/propublica/main",

  // Tech (added to balance the politics-heavy world-news roster)
  arstechnica: "https://arstechnica.com/feed/",
  the_verge: "https://www.theverge.com/rss/index.xml",
  mit_tech_review: "https://www.technologyreview.com/feed/",
  four04_media: "https://www.404media.co/rss/",

  // Science
  quanta: "https://www.quantamagazine.org/feed/",
  sciencedaily: "https://www.sciencedaily.com/rss/top.xml",
  new_scientist: "https://www.newscientist.com/feed/home/",
  nature_news: "https://www.nature.com/nature.rss",

  // Environment / climate
  carbon_brief: "https://www.carbonbrief.org/feed/",
  inside_climate: "https://insideclimatenews.org/feed/",
  grist: "https://grist.org/feed/",

  // Health
  stat_news: "https://www.statnews.com/feed/",
  kff_health: "https://kffhealthnews.org/feed/",

  // Deregistered (kept here as documentation):
  //   reuters_world — public RSS deprecated (406)
  //   ap_top        — URL returns 404
  //   semafor       — no public feed found
};

const PARSER = new Parser({
  timeout: 10_000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (compatible; Blurpadurp/0.1; +https://blurpadurp.com)",
    // Nature/Science and similar "strict" feed servers reject narrow
    // Accept lists with 406. The wildcard fallback at the end covers
    // them while keeping the explicit RSS/Atom types up front.
    Accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*",
  },
});

// Drop RSS items whose pubDate is older than this, and items with no
// pubDate at all. Quality feeds always date their items; a missing date
// usually means evergreen or archive content (e.g. the Economist mixes
// reprints from prior years into its RSS). A 30-day window gives enough
// slack for mid-pipeline delays without admitting actual archive items.
const MAX_RSS_AGE_MS = 30 * 24 * 3600_000;

// Some high-trust feeds omit pubDate as a matter of convention (Nature
// in particular). For these, accept items without a pubDate and let
// the compose-layer ingest window (14 days from ingested_at) enforce
// freshness instead. Keep this list short and trusted.
const FEEDS_ALLOW_MISSING_PUBDATE = new Set<string>([
  "nature_news",
]);

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

    const allowMissingDate = FEEDS_ALLOW_MISSING_PUBDATE.has(scope);
    const items = feed.items
      .filter((i) => typeof i.link === "string" && i.link.length > 0)
      .filter((i) => {
        const d = i.pubDate ? safeDate(i.pubDate) : null;
        if (d === null) {
          if (allowMissingDate) return true; // freshness enforced downstream
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
