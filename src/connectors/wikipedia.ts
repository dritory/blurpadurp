// Wikipedia connector. Two scopes:
//
//  - in_the_news     — the small editor-curated "In the News" box on
//                      the main page. ~3-6 items at any time. Highest
//                      bar of any source we have.
//  - current_events  — Portal:Current_events daily pages. ~5-30 items
//                      per day, structured by region/topic. Less
//                      strict than ITN but still human-curated.
//
// Both scopes pull from English Wikipedia. Wikipedia editors apply an
// implicit significance filter — the fact that an event reached either
// surface is itself a strong "this matters" signal. The journalism
// itself happens at the underlying news sources Wikipedia cites; we
// link back to the Wikipedia article (which links onward to its
// references). Future enhancement: scrape the article's references to
// surface the underlying news sources directly.
//
// Stable identifiers:
//  - in_the_news     — Wikipedia article URL (the primary linked
//                      article in each story). Stable across days as
//                      long as the article stays on ITN.
//  - current_events  — date + first link href (composite hash). Less
//                      stable across edits; we treat re-ingest as
//                      idempotent via ON CONFLICT DO UPDATE.

import { createHash } from "node:crypto";

import type {
  Connector,
  Cursor,
  NormalizedStoryInput,
  RawSourceItem,
} from "./types.ts";

const FEED_API = "https://en.wikipedia.org/api/rest_v1/feed/featured";
const PARSE_API = "https://en.wikipedia.org/w/api.php";

const USER_AGENT =
  "Blurpadurp/0.1 (https://blurpadurp.com; ops@blurpadurp.com)";

const SCOPES = ["in_the_news", "current_events"] as const;
type Scope = (typeof SCOPES)[number];

// How many days back to walk for the Current Events portal. Today is
// usually thin (in-progress); yesterday is full; 2-3 days back is
// where most news lives. compose-layer 14d ingest window catches the
// freshness side.
const CURRENT_EVENTS_LOOKBACK_DAYS = 4;

interface WikiNewsItem {
  story: string; // HTML
  links: Array<{
    titles?: { normalized?: string; canonical?: string };
    content_urls?: { desktop?: { page?: string } };
  }>;
}

interface InTheNewsRaw {
  scope: "in_the_news";
  primaryTitle: string;
  primaryUrl: string;
  storyHtml: string;
  storyText: string;
  fetchedAt: Date;
}

interface CurrentEventsRaw {
  scope: "current_events";
  date: string; // ISO date
  text: string;
  primaryUrl: string;
  primaryTitle: string;
  fetchedAt: Date;
}

export const wikipedia: Connector = {
  name: "wikipedia",

  scopes(): string[] {
    return [...SCOPES];
  },

  async fetchSince(cursor: Cursor): Promise<RawSourceItem[]> {
    const scope = (cursor.scope_key as Scope) ?? "";
    if (!SCOPES.includes(scope)) {
      throw new Error(`wikipedia: unknown scope "${scope}"`);
    }
    if (scope === "in_the_news") {
      return fetchInTheNews();
    }
    return fetchCurrentEvents();
  },

  normalize(item: RawSourceItem): NormalizedStoryInput {
    const raw = item.raw as InTheNewsRaw | CurrentEventsRaw;
    if (raw.scope === "in_the_news") {
      return {
        source_name: "wikipedia",
        source_event_id: raw.primaryUrl,
        source_url: raw.primaryUrl,
        // Title = the story sentence itself, not the linked Wikipedia
        // article's name. "Nord (yacht)" tells us nothing; "Russian
        // oligarch's superyacht crosses Strait of Hormuz" is the news.
        title: firstSentence(raw.storyText, 200),
        summary: raw.storyText,
        published_at: null, // ITN doesn't expose per-item dates reliably
      };
    }
    return {
      source_name: "wikipedia",
      source_event_id: item.source_event_id,
      source_url: raw.primaryUrl,
      // Same logic for Current Events: the bullet text IS the headline.
      // Using the citation-parenthetical link text ("(Reuters)") as
      // title was the bug — that's metadata, not content.
      title: firstSentence(raw.text, 200),
      summary: raw.text,
      published_at: new Date(raw.date),
    };
  },
};

// Take up to `max` chars or up to the first sentence boundary,
// whichever is shorter. RSS-style "headline-as-first-sentence" yields
// usable story titles from a paragraph of body text.
function firstSentence(text: string, max: number): string {
  if (text.length === 0) return "";
  const trimmed = text.length > max ? text.slice(0, max) : text;
  const m = trimmed.match(/^(.{20,}?[.!?])\s/);
  if (m && m[1] !== undefined) return m[1].trim();
  return trimmed.trim();
}

// --- in_the_news ---

async function fetchInTheNews(): Promise<RawSourceItem[]> {
  const today = new Date();
  const path = `${today.getUTCFullYear()}/${pad2(today.getUTCMonth() + 1)}/${pad2(today.getUTCDate())}`;
  const url = `${FEED_API}/${path}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(
      `wikipedia in_the_news: ${res.status} ${res.statusText}`,
    );
  }
  const body = (await res.json()) as { news?: WikiNewsItem[] };
  const news = body.news ?? [];
  const fetchedAt = new Date();
  const out: RawSourceItem[] = [];
  for (const n of news) {
    const primary = n.links?.[0];
    const primaryUrl = primary?.content_urls?.desktop?.page ?? "";
    const primaryTitle =
      primary?.titles?.normalized ?? primary?.titles?.canonical ?? "";
    if (!primaryUrl || !primaryTitle) continue;
    const storyHtml = n.story ?? "";
    const storyText = stripHtml(storyHtml);
    out.push({
      source_event_id: primaryUrl,
      fetched_at: fetchedAt,
      raw: {
        scope: "in_the_news",
        primaryTitle,
        primaryUrl,
        storyHtml,
        storyText,
        fetchedAt,
      } satisfies InTheNewsRaw,
    });
  }
  return out;
}

// --- current_events ---

async function fetchCurrentEvents(): Promise<RawSourceItem[]> {
  const fetchedAt = new Date();
  const out: RawSourceItem[] = [];
  for (let i = 0; i < CURRENT_EVENTS_LOOKBACK_DAYS; i++) {
    const day = new Date(fetchedAt.getTime() - i * 24 * 3600_000);
    const pageTitle = `Portal:Current_events/${day.getUTCFullYear()}_${MONTH_NAMES[day.getUTCMonth()]}_${day.getUTCDate()}`;
    const url = `${PARSE_API}?action=parse&page=${encodeURIComponent(pageTitle)}&format=json&prop=text`;
    let html: string;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      if (!res.ok) continue;
      const body = (await res.json()) as {
        parse?: { text: { "*": string } };
        error?: unknown;
      };
      if (body.error || !body.parse) continue;
      html = body.parse.text["*"];
    } catch {
      continue;
    }
    const items = extractCurrentEventsItems(html);
    const dayIso = day.toISOString().slice(0, 10);
    for (const it of items) {
      const eventId = sha1(`${dayIso}::${it.primaryUrl}`);
      out.push({
        source_event_id: eventId,
        fetched_at: fetchedAt,
        raw: {
          scope: "current_events",
          date: dayIso,
          text: it.text,
          primaryUrl: it.primaryUrl,
          primaryTitle: it.primaryTitle,
          fetchedAt,
        } satisfies CurrentEventsRaw,
      });
    }
  }
  return out;
}

// Walk the rendered Current Events page and extract one entry per
// terminal <li> (the leaf bullets that contain a description). Skips
// the navbar and section heading lists. Uses regex parsing because the
// structure is consistent and we want to avoid pulling in a full HTML
// parser dependency.
function extractCurrentEventsItems(html: string): Array<{
  text: string;
  primaryUrl: string;
  primaryTitle: string;
}> {
  const items: Array<{
    text: string;
    primaryUrl: string;
    primaryTitle: string;
  }> = [];
  // Match each <li>...</li>; the regex is non-greedy and avoids the
  // navbar via class checks below.
  const liRe = /<li([^>]*)>([\s\S]*?)<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = liRe.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    const inner = m[2] ?? "";
    // Skip navbar items + nested-only LIs (LIs that contain other LIs
    // are section containers; we want the leaves).
    if (/current-events-navbar/.test(attrs)) continue;
    if (/<li/.test(inner)) continue;
    const text = stripHtml(inner).replace(/\s+/g, " ").trim();
    if (text.length < 20) continue; // skip thin entries
    // Prefer the first external link as the news source; fall back to
    // first Wikipedia article link.
    const linkMatch =
      inner.match(/<a[^>]+class="[^"]*external[^"]*"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/i) ??
      inner.match(/<a[^>]+href="(\/wiki\/[^"]+)"[^>]*>([^<]+)<\/a>/i);
    if (!linkMatch) continue;
    const href = linkMatch[1]!;
    const linkText = linkMatch[2]!;
    const primaryUrl = href.startsWith("/")
      ? `https://en.wikipedia.org${href}`
      : href;
    items.push({ text, primaryUrl, primaryTitle: linkText.trim() });
  }
  return items;
}

// --- helpers ---

function stripHtml(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
