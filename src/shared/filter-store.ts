// Shared DB plumbing for the ingest-boundary noise filters. Both the
// title-regex (title_regex_filter) and URL-path (url_path_filter) filters
// share the same (pattern, mode, hits) table shape and the same two-mode
// design — 'block' drops at ingest, 'tag' persists for false-positive
// evaluation before promoting to block. Only the *match* step genuinely
// differs (JS RegExp vs URL substring), so that stays in the two
// strategy modules (title-noise.ts / url-noise.ts); the load and
// hit-recording plumbing is generalized here over the table name.

import { sql } from "kysely";
import { db } from "../db/index.ts";

export type FilterMode = "block" | "tag";

// The (pattern, mode, hits) filter tables.
export type FilterTable = "title_regex_filter" | "url_path_filter";

// A loaded filter row, mode normalized.
export interface FilterRow {
  pattern: string;
  mode: FilterMode;
}

// A classification hit. The two classifiers return this same shape.
export interface FilterMatch {
  pattern: string;
  mode: FilterMode;
}

// Snapshot-load all (pattern, mode) rows from a filter table. Ingest
// loads the full list once at the start of a run; operator changes take
// effect on the next ingest, not mid-run.
export async function loadFilterRows(table: FilterTable): Promise<FilterRow[]> {
  const rows = await db.selectFrom(table).select(["pattern", "mode"]).execute();
  return rows.map((r) => ({
    pattern: r.pattern,
    mode: r.mode === "block" ? "block" : "tag",
  }));
}

// Bump the hits column for matched patterns. Called once at the end of an
// ingest run with a per-pattern count, so we get observability without
// paying a write per matched row.
export async function bumpFilterHits(
  table: FilterTable,
  hits: ReadonlyMap<string, number>,
): Promise<void> {
  if (hits.size === 0) return;
  for (const [pattern, n] of hits) {
    if (n <= 0) continue;
    await db
      .updateTable(table)
      .set({ hits: sql`hits + ${n}` })
      .where("pattern", "=", pattern)
      .execute();
  }
}
