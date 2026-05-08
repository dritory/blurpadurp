// URL path-segment classifier, driven by the url_path_filter table.
// Each filter row has a mode of 'block' (drop at ingest) or 'tag'
// (persist with story.noise_pattern set, used for false-positive
// evaluation before promoting to block).
//
// Snapshot semantics: ingest loads the full filter list once at the
// start of a run (loadUrlPathFilters), then classifies every URL
// against the snapshot. Operator changes via /admin/path-filters
// take effect on the next ingest, not mid-run.

import { sql } from "kysely";
import { db } from "../db/index.ts";

export type FilterMode = "block" | "tag";

export interface UrlPathFilter {
  pattern: string;
  mode: FilterMode;
}

export interface FilterMatch {
  pattern: string;
  mode: FilterMode;
}

export async function loadUrlPathFilters(): Promise<UrlPathFilter[]> {
  const rows = await db
    .selectFrom("url_path_filter")
    .select(["pattern", "mode"])
    .execute();
  return rows.map((r) => ({
    pattern: r.pattern,
    mode: r.mode === "block" ? "block" : "tag",
  }));
}

export function classifyUrl(
  url: string | null,
  filters: readonly UrlPathFilter[],
): FilterMatch | null {
  if (url === null) return null;
  const lower = url.toLowerCase();
  for (const f of filters) {
    if (lower.includes(f.pattern)) {
      return { pattern: f.pattern, mode: f.mode };
    }
  }
  return null;
}

// Bumps the hits column for matched patterns. Called once at the end
// of an ingest run with a per-pattern count, so we get the
// observability without paying a write per matched URL.
export async function recordFilterHits(
  hits: ReadonlyMap<string, number>,
): Promise<void> {
  if (hits.size === 0) return;
  for (const [pattern, n] of hits) {
    if (n <= 0) continue;
    await db
      .updateTable("url_path_filter")
      .set({ hits: sql`hits + ${n}` })
      .where("pattern", "=", pattern)
      .execute();
  }
}
