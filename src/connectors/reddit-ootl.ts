// Reddit r/OutOfTheLoop connector. The subreddit's premise IS our signal:
// posts are questions of the form "What's going on with X?" — which means
// X is something mainstream-enough to be discussed but non-obvious enough
// that a literate reader needs catch-up context. That's a much sharper
// zeitgeist signal than raw article volume.
//
// We ingest the *question posts*. Title = the question. The scorer decides
// whether the referenced thing belongs in the brief — this connector just
// surfaces "people are asking about this."
//
// Uses the public JSON endpoint (/r/.../top.json?t=week). No auth, but
// Reddit enforces a custom User-Agent; reused default below.

import type {
  Connector,
  Cursor,
  NormalizedStoryInput,
  RawSourceItem,
} from "./types.ts";

const SUBREDDIT = "OutOfTheLoop";
const TOP_ENDPOINT = `https://www.reddit.com/r/${SUBREDDIT}/top.json?t=week&limit=50`;
const USER_AGENT = "blurpadurp/0.1 (+https://blurpadurp.com)";
// Drop low-engagement posts — they're questions no one found interesting.
// 100 upvotes within a week is the rough line between "someone asking"
// and "many people asking", and this connector only cares about the latter.
const MIN_SCORE = 100;
const MIN_COMMENTS = 25;

interface RedditChild {
  kind: string;
  data: RedditPost;
}

interface RedditPost {
  id: string;
  permalink: string;
  title: string;
  selftext: string | null;
  score: number;
  num_comments: number;
  created_utc: number;
  is_self: boolean;
  over_18: boolean;
  stickied: boolean;
  link_flair_text: string | null;
}

interface RedditListing {
  data: {
    children: RedditChild[];
  };
}

export const redditOotl: Connector = {
  name: "reddit_ootl",

  async fetchSince(cursor: Cursor): Promise<RawSourceItem[]> {
    const res = await fetch(TOP_ENDPOINT, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`reddit_ootl: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as RedditListing;
    const lastSeen = cursor.last_seen_at?.getTime() ?? 0;
    const fetched_at = new Date();

    const posts = json.data.children
      .map((c) => c.data)
      .filter(
        (p) =>
          p.is_self === true &&
          p.over_18 === false &&
          p.stickied === false &&
          p.score >= MIN_SCORE &&
          p.num_comments >= MIN_COMMENTS &&
          p.created_utc * 1000 > lastSeen,
      );

    return posts.map((p) => ({
      source_event_id: `reddit_ootl:${p.id}`,
      fetched_at,
      raw: p,
    }));
  },

  normalize(item: RawSourceItem): NormalizedStoryInput {
    const p = item.raw as RedditPost;
    const published_at = new Date(p.created_utc * 1000);
    return {
      source_name: "reddit_ootl",
      source_event_id: item.source_event_id,
      source_url: `https://www.reddit.com${p.permalink}`,
      title: cleanTitle(p.title),
      summary: p.selftext !== null && p.selftext.trim().length > 0
        ? p.selftext.trim().slice(0, 800)
        : null,
      published_at,
      viral_signals: {
        cross_platform_count: undefined,
        mainstream_crossover: undefined,
      },
    };
  },
};

// r/OutOfTheLoop titles almost always start with "What's going on with"
// or similar. The substance is what follows. Keep the "?" — it signals
// the register to the scorer.
export function cleanTitle(raw: string): string {
  const prefixes = [
    /^\s*what'?s?\s+(going|the\s+deal)\s+(on\s+)?with\s+/i,
    /^\s*what\s+is\s+(going\s+on\s+with|the\s+deal\s+with)\s+/i,
    /^\s*why\s+(is|are)\s+/i,
    /^\s*can\s+someone\s+explain\s+/i,
  ];
  let cleaned = raw.trim();
  for (const re of prefixes) {
    const m = re.exec(cleaned);
    if (m) {
      cleaned = cleaned.slice(m[0].length);
      break;
    }
  }
  // Capitalize first letter; preserve the rest.
  if (cleaned.length > 0) {
    cleaned = cleaned[0]!.toUpperCase() + cleaned.slice(1);
  }
  return cleaned.length > 0 ? cleaned : raw;
}
