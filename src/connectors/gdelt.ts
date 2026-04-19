import { createHash } from "node:crypto";
import type { Connector, Cursor, NormalizedStoryInput, RawSourceItem } from "./types.ts";

const API = "https://api.gdeltproject.org/api/v2/doc/doc";
const MAX_RECORDS = 250;
// Default look-back when there is no cursor yet.
const DEFAULT_LOOKBACK_MS = 6 * 60 * 60 * 1000; // 6 hours

interface GdeltArticle {
  url: string;
  title: string;
  seendate: string; // "20240101T120000Z"
  domain: string;
  language: string;
  sourcecountry: string;
  tone?: number;
  socialimage?: string;
}

function parseSeendate(s: string): Date {
  // "20240101T120000Z" → ISO 8601
  return new Date(
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`
  );
}

function toGdeltTs(d: Date): string {
  // "YYYYMMDDHHMMSS" — strip separators from ISO string
  return d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function urlId(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

export const gdelt: Connector = {
  name: "gdelt",

  async fetchSince(cursor: Cursor): Promise<RawSourceItem[]> {
    const since = cursor.last_seen_at ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS);
    const until = new Date();

    const params = new URLSearchParams({
      query: "sourcelang:english",
      mode: "ArtList",
      maxrecords: String(MAX_RECORDS),
      format: "json",
      sort: "DateDesc",
      startdatetime: toGdeltTs(since),
      enddatetime: toGdeltTs(until),
    });

    const res = await fetch(`${API}?${params}`);
    if (!res.ok) throw new Error(`GDELT responded ${res.status}`);

    const data = (await res.json()) as { articles?: GdeltArticle[] };
    const fetched_at = new Date();

    return (data.articles ?? []).map((a) => ({
      source_event_id: urlId(a.url),
      fetched_at,
      raw: a,
    }));
  },

  normalize(item: RawSourceItem): NormalizedStoryInput {
    const a = item.raw as GdeltArticle;
    return {
      source_name: "gdelt",
      source_event_id: item.source_event_id,
      source_url: a.url,
      title: a.title,
      summary: null,
      published_at: parseSeendate(a.seendate),
      gdelt_metadata: {
        tone_mean: a.tone,
      },
    };
  },
};
