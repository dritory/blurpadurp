// Storage budget snapshot for /admin/status. Heavier than the
// freshness payload in status.ts (per-table catalog sizes + a couple of
// story/ai_call_log aggregates), so it lives only on the admin page —
// never on /health or /status, which must stay cheap (see CLAUDE.md:
// don't add unbounded scans to frequently-hit paths). The goal is to
// make the 500 MB Neon free-tier ceiling self-measuring: where the
// space is, how fast it grows, and a rough months-to-cap. See
// docs/storage.md.

import { sql } from "kysely";
import { db } from "../db/index.ts";

// Neon free-tier storage ceiling. Hardcoded (not config) because it's a
// property of the plan, not a tunable.
export const STORAGE_CAP_BYTES = 500 * 1024 * 1024;

export interface TableSize {
  name: string;
  totalBytes: number;
  heapBytes: number;
  indexBytes: number;
  toastBytes: number;
  rows: number;
}

export interface StorageStatus {
  totalBytes: number;
  capBytes: number;
  tables: TableSize[];
  story: {
    total: number;
    scored: number;
    unscored: number;
    earlyReject: number;
    coldStored: number;
    inlinePayload: number;
    hasEmbedding: number;
  };
  aiCallLog: { inline: number; cold: number };
  coldTier: { enabled: boolean; ageDays: number };
  growth: {
    stories30d: number;
    aiCalls30d: number;
    estMonthlyBytes: number;
    monthsToCap: number | null;
  };
}

export async function loadStorageStatus(): Promise<StorageStatus> {
  const totalRow = await sql<{ bytes: string }>`
    SELECT pg_database_size(current_database()) AS bytes
  `.execute(db);
  const totalBytes = Number(totalRow.rows[0]?.bytes ?? 0);

  const tableRows = await sql<{
    name: string;
    total: string;
    heap: string;
    indexes: string;
    toast: string;
    rows: string;
  }>`
    SELECT relname AS name,
           pg_total_relation_size(c.oid) AS total,
           pg_relation_size(c.oid) AS heap,
           pg_indexes_size(c.oid) AS indexes,
           (pg_total_relation_size(c.oid)
             - pg_relation_size(c.oid)
             - pg_indexes_size(c.oid)) AS toast,
           c.reltuples::bigint AS rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY pg_total_relation_size(c.oid) DESC
    LIMIT 12
  `.execute(db);
  const tables: TableSize[] = tableRows.rows.map((r) => ({
    name: r.name,
    totalBytes: Number(r.total),
    heapBytes: Number(r.heap),
    indexBytes: Number(r.indexes),
    toastBytes: Number(r.toast),
    rows: Number(r.rows),
  }));

  const storyRow = await sql<{
    total: string;
    scored: string;
    unscored: string;
    early_reject: string;
    cold_stored: string;
    inline_payload: string;
    has_embedding: string;
  }>`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE scored_at IS NOT NULL)  AS scored,
           count(*) FILTER (WHERE scored_at IS NULL)      AS unscored,
           count(*) FILTER (WHERE early_reject)           AS early_reject,
           count(*) FILTER (WHERE payload_key IS NOT NULL) AS cold_stored,
           count(*) FILTER (WHERE raw_output IS NOT NULL) AS inline_payload,
           count(*) FILTER (WHERE embedding IS NOT NULL)  AS has_embedding
    FROM story
  `.execute(db);
  const sr = storyRow.rows[0];

  const aiRow = await sql<{ inline: string; cold: string }>`
    SELECT count(*) FILTER (
             WHERE payload_key IS NULL
               AND (input_jsonb IS NOT NULL OR output_jsonb IS NOT NULL)
           ) AS inline,
           count(*) FILTER (WHERE payload_key IS NOT NULL) AS cold
    FROM ai_call_log
  `.execute(db);
  const ar = aiRow.rows[0];

  const growthRow = await sql<{ stories_30d: string; ai_30d: string }>`
    SELECT (SELECT count(*) FROM story
             WHERE ingested_at > now() - interval '30 days')   AS stories_30d,
           (SELECT count(*) FROM ai_call_log
             WHERE started_at > now() - interval '30 days')    AS ai_30d
  `.execute(db);
  const stories30d = Number(growthRow.rows[0]?.stories_30d ?? 0);
  const aiCalls30d = Number(growthRow.rows[0]?.ai_30d ?? 0);

  // Per-row average bytes from the current tables, applied to the
  // 30-day intake → a rough monthly growth. Conservative as the cold
  // tier kicks in (offload shrinks per-row bytes over time).
  const byName = new Map(tables.map((t) => [t.name, t]));
  const storyTbl = byName.get("story");
  const aiTbl = byName.get("ai_call_log");
  const perRow = (t: TableSize | undefined): number =>
    t && t.rows > 0 ? t.totalBytes / t.rows : 0;
  const estMonthlyBytes =
    stories30d * perRow(storyTbl) + aiCalls30d * perRow(aiTbl);
  const headroom = STORAGE_CAP_BYTES - totalBytes;
  const monthsToCap =
    estMonthlyBytes > 0 ? Math.max(0, headroom) / estMonthlyBytes : null;

  const cfgRows = await db
    .selectFrom("config")
    .select(["key", "value"])
    .where("key", "in", ["storage.cold_tier", "storage.cold_tier_age_days"])
    .execute();
  const cfg = new Map(cfgRows.map((r) => [r.key, r.value]));
  const ageVal = cfg.get("storage.cold_tier_age_days");

  return {
    totalBytes,
    capBytes: STORAGE_CAP_BYTES,
    tables,
    story: {
      total: Number(sr?.total ?? 0),
      scored: Number(sr?.scored ?? 0),
      unscored: Number(sr?.unscored ?? 0),
      earlyReject: Number(sr?.early_reject ?? 0),
      coldStored: Number(sr?.cold_stored ?? 0),
      inlinePayload: Number(sr?.inline_payload ?? 0),
      hasEmbedding: Number(sr?.has_embedding ?? 0),
    },
    aiCallLog: { inline: Number(ar?.inline ?? 0), cold: Number(ar?.cold ?? 0) },
    coldTier: {
      enabled: cfg.get("storage.cold_tier") === true,
      ageDays: typeof ageVal === "number" ? ageVal : Number(ageVal ?? 14),
    },
    growth: { stories30d, aiCalls30d, estMonthlyBytes, monthsToCap },
  };
}
