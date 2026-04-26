// GDELT connector (BigQuery / Event DB). Queries `events` + `eventmentions`
// on gdelt-bq.gdeltv2, deduplicates by GLOBALEVENTID, scrapes titles from
// the canonical URL, and emits one NormalizedStoryInput per event.
//
// Setup: GOOGLE_APPLICATION_CREDENTIALS points at a service account JSON
// with BigQuery Data Viewer + Job User; GOOGLE_CLOUD_PROJECT is the GCP
// project id to bill queries to (free tier covers the small volumes we
// scan).

import { BigQuery } from "@google-cloud/bigquery";

import { getEnvOptional } from "../shared/env.ts";
import { TIER1_DOMAINS, domainOf } from "../shared/source-tiers.ts";
import type {
  Connector,
  Cursor,
  NormalizedStoryInput,
  RawSourceItem,
} from "./types.ts";

const MIN_NUM_MENTIONS = 20; // drop single-article events
const LOOKBACK_HOURS_DEFAULT = 24;

const LOOKBACK_HOURS_MAX = 72;
const LOOKBACK_HOURS_MIN = 1;
const MAX_EVENTS_PER_RUN = 500;
// Fetch more rows than we need because GDELT emits multiple events per
// article (different actor/actor/event-code extractions) which collapse
// down to fewer unique canonical URLs after dedup.
const FETCH_OVERFETCH_FACTOR = 4;
const MAX_URLS_PER_EVENT = 10;
const SCRAPE_CONCURRENCY = 10;
const SCRAPE_TIMEOUT_MS = 5_000;

// BigQuery client is constructed lazily on first use. Module-top-level
// construction would throw at import time when GOOGLE_CLOUD_PROJECT or
// GOOGLE_APPLICATION_CREDENTIALS are missing — and that import sits
// inside connectors/registry.ts, so a single bad env var in prod
// would take down every connector, not just GDELT. Lazy init keeps
// the failure scoped: ingest's per-connector try/catch logs the
// problem and the other sources keep running.
let _bq: BigQuery | null = null;
function getBigQuery(): BigQuery {
  if (_bq !== null) return _bq;
  const projectId = getEnvOptional("GOOGLE_CLOUD_PROJECT");
  if (projectId === undefined || projectId.length === 0) {
    throw new Error(
      "gdelt: GOOGLE_CLOUD_PROJECT not set — connector skipped this run. " +
        "Set the secret in Fly (fly secrets set GOOGLE_CLOUD_PROJECT=<id>) " +
        "or remove gdelt from connectors/registry.ts to silence.",
    );
  }
  _bq = new BigQuery({ projectId });
  return _bq;
}

interface EventRow {
  global_event_id: string;
  canonical_url: string;
  num_mentions: number;
  avg_tone: number;
  event_root_code: string | null;
  event_code: string | null;
  actor1_name: string | null;
  actor2_name: string | null;
  sqldate: number;
  all_urls: string[];
}

interface EventPayload extends EventRow {
  title: string;
  published_at: Date | null;
}

export const gdelt: Connector = {
  name: "gdelt",

  async fetchSince(cursor: Cursor): Promise<RawSourceItem[]> {
    const { start, end } = computeRange(cursor.last_seen_at);
    const rows = await queryEvents(start, end);
    const deduped = dedupByCanonicalUrl(rows);
    const reranked = rerankByTier1(deduped).slice(0, MAX_EVENTS_PER_RUN);
    const payloads = await enrichWithTitles(reranked);
    const fetched_at = new Date();
    return payloads.map((p) => ({
      source_event_id: p.global_event_id,
      fetched_at,
      raw: p,
    }));
  },

  normalize(item: RawSourceItem): NormalizedStoryInput {
    const p = item.raw as EventPayload;
    const additional = p.all_urls.filter((u) => u !== p.canonical_url);
    // source_event_id uses the canonical URL (article-level) rather than
    // GLOBALEVENTID (event-level): GDELT extracts a new GLOBALEVENTID each
    // time the same article is reprocessed, so event-level IDs don't
    // dedupe cross-run ingests. URL as ID lets ON CONFLICT refresh the
    // row instead of inserting a new one. The GLOBALEVENTID is preserved
    // in gdelt_metadata for analysis.
    return {
      source_name: "gdelt",
      source_event_id: p.canonical_url,
      source_url: p.canonical_url,
      additional_source_urls: additional,
      title: p.title,
      summary: null,
      published_at: p.published_at,
      gdelt_metadata: {
        event_id: p.global_event_id,
        source_count: p.num_mentions,
        tone_mean: p.avg_tone,
      },
    };
  },
};

function computeRange(lastSeen: Date | null): { start: Date; end: Date } {
  const end = new Date();
  let target: Date;
  if (lastSeen === null) {
    target = new Date(end.getTime() - LOOKBACK_HOURS_DEFAULT * 3600_000);
  } else {
    const sinceMs = end.getTime() - lastSeen.getTime();
    const hours = Math.min(
      LOOKBACK_HOURS_MAX,
      Math.max(LOOKBACK_HOURS_MIN, Math.ceil(sinceMs / 3600_000)),
    );
    target = new Date(end.getTime() - hours * 3600_000);
  }
  // GDELT partitions are daily at 00:00 UTC. Floor start to the partition
  // boundary so the partition filter always includes the relevant day's
  // partition; without this, an intra-day cursor excludes today's data.
  const start = new Date(
    Date.UTC(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      target.getUTCDate(),
    ),
  );
  return { start, end };
}

async function queryEvents(start: Date, end: Date): Promise<EventRow[]> {
  // Partition-filter guard: both tables are partitioned on _PARTITIONTIME.
  // Queries without both bounds would scan the full table (free tier ruin).
  if (!(start instanceof Date) || !(end instanceof Date)) {
    throw new Error("gdelt: queryEvents requires Date start/end");
  }
  if (end.getTime() - start.getTime() > LOOKBACK_HOURS_MAX * 3600_000) {
    throw new Error(
      `gdelt: query window exceeds ${LOOKBACK_HOURS_MAX}h partition cap`,
    );
  }

  // Inline partition timestamps as literals: BigQuery's partition pruner
  // fails to match @param bindings against _PARTITIONTIME, causing
  // full-table scans to be rejected and 0 rows returned. Start/end are
  // validated Date objects above, so their ISO form is safe to embed.
  const startLit = `TIMESTAMP("${start.toISOString()}")`;
  const endLit = `TIMESTAMP("${end.toISOString()}")`;

  const sql = `
    WITH windowed_events AS (
      SELECT
        CAST(GLOBALEVENTID AS STRING) AS global_event_id,
        SOURCEURL AS canonical_url,
        NumMentions AS num_mentions,
        AvgTone AS avg_tone,
        CAST(EventRootCode AS STRING) AS event_root_code,
        CAST(EventCode AS STRING) AS event_code,
        Actor1Name AS actor1_name,
        Actor2Name AS actor2_name,
        SQLDATE AS sqldate
      FROM \`gdelt-bq.gdeltv2.events_partitioned\`
      WHERE _PARTITIONTIME BETWEEN ${startLit} AND ${endLit}
        AND NumMentions >= @min_mentions
        AND SOURCEURL IS NOT NULL
    ),
    windowed_mentions AS (
      SELECT
        CAST(GLOBALEVENTID AS STRING) AS global_event_id,
        ARRAY_AGG(DISTINCT MentionIdentifier IGNORE NULLS LIMIT @max_urls) AS all_urls
      FROM \`gdelt-bq.gdeltv2.eventmentions_partitioned\`
      WHERE _PARTITIONTIME BETWEEN ${startLit} AND ${endLit}
      GROUP BY global_event_id
    )
    SELECT
      e.*,
      COALESCE(m.all_urls, [e.canonical_url]) AS all_urls
    FROM windowed_events e
    LEFT JOIN windowed_mentions m USING (global_event_id)
    ORDER BY e.num_mentions DESC
    LIMIT @max_events
  `;

  const [rows] = await getBigQuery().query({
    query: sql,
    params: {
      min_mentions: MIN_NUM_MENTIONS,
      max_urls: MAX_URLS_PER_EVENT,
      max_events: MAX_EVENTS_PER_RUN * FETCH_OVERFETCH_FACTOR,
    },
    types: {
      min_mentions: "INT64",
      max_urls: "INT64",
      max_events: "INT64",
    },
  });
  return rows as EventRow[];
}

// Re-rank events by tier-1 source coverage: an event cited by Reuters+BBC
// beats one with higher raw num_mentions spread across regional
// aggregators. Also swaps the canonical URL to a tier-1 member when one
// exists, so normalize() surfaces the reputable URL as primary.
function rerankByTier1(rows: EventRow[]): EventRow[] {
  const scored = rows.map((r) => {
    const tier1Urls = r.all_urls.filter((u) => {
      const d = domainOf(u);
      return d !== null && TIER1_DOMAINS.has(d);
    });
    const canonical = tier1Urls[0] ?? r.canonical_url;
    return {
      ...r,
      canonical_url: canonical,
      tier1_count: tier1Urls.length,
    };
  });
  scored.sort((a, b) => {
    if (b.tier1_count !== a.tier1_count) return b.tier1_count - a.tier1_count;
    return b.num_mentions - a.num_mentions;
  });
  return scored.map(({ tier1_count: _ignore, ...row }) => row);
}

// Collapse rows that share a canonical URL. GDELT emits one row per
// extracted event tuple; a single article often yields N such events.
// We keep the row with highest num_mentions as the representative and
// union the mention URLs across all events that share the URL.
function dedupByCanonicalUrl(rows: EventRow[]): EventRow[] {
  const groups = new Map<string, EventRow>();
  const urlSets = new Map<string, Set<string>>();

  for (const r of rows) {
    const key = r.canonical_url;
    const existing = groups.get(key);
    const urls = urlSets.get(key) ?? new Set<string>();
    for (const u of r.all_urls) urls.add(u);
    urls.add(r.canonical_url);
    urlSets.set(key, urls);

    if (!existing || r.num_mentions > existing.num_mentions) {
      groups.set(key, r);
    }
  }

  const out: EventRow[] = [];
  for (const [url, row] of groups) {
    out.push({ ...row, all_urls: Array.from(urlSets.get(url) ?? []) });
  }
  out.sort((a, b) => b.num_mentions - a.num_mentions);
  return out;
}

async function enrichWithTitles(rows: EventRow[]): Promise<EventPayload[]> {
  const results: EventPayload[] = [];
  for (let i = 0; i < rows.length; i += SCRAPE_CONCURRENCY) {
    const batch = rows.slice(i, i + SCRAPE_CONCURRENCY);
    const settled = await Promise.all(
      batch.map((r) => scrapeTitle(r.canonical_url).then((t) => ({ r, t }))),
    );
    for (const { r, t } of settled) {
      if (!t) continue;
      results.push({
        ...r,
        title: t,
        published_at: parseSqlDate(r.sqldate),
      });
    }
  }
  return results;
}

async function scrapeTitle(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Blurpadurp/0.1; +https://blurpadurp.com)",
        Accept: "text/html",
      },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/html")) return null;
    const html = (await res.text()).slice(0, 200_000); // cap large pages
    return extractTitle(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractTitle(html: string): string | null {
  const og =
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(
      html,
    ) ??
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i.exec(
      html,
    );
  const raw = og?.[1] ?? /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1];
  if (!raw) return null;
  return decodeHtmlEntities(raw).trim().slice(0, 500) || null;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replaceAll(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCharCode(parseInt(n, 16)),
    );
}

function parseSqlDate(sqldate: number): Date | null {
  const s = String(sqldate);
  if (s.length !== 8) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}
