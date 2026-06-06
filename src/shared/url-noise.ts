// URL path-segment classifier, driven by the url_path_filter table.
// Each filter row has a mode of 'block' (drop at ingest) or 'tag'
// (persist with story.noise_pattern set, used for false-positive
// evaluation before promoting to block).
//
// The load + hit-recording DB plumbing lives in filter-store.ts (shared
// with title-noise.ts); this module owns only the URL-substring match
// strategy. Snapshot semantics: ingest loads the full filter list once at
// the start of a run, then classifies every URL against the snapshot.
// Operator changes via /admin/path-filters take effect on the next ingest.

import {
  bumpFilterHits,
  loadFilterRows,
  type FilterMatch,
  type FilterMode,
  type FilterRow,
} from "./filter-store.ts";

export type { FilterMode, FilterMatch };
export type UrlPathFilter = FilterRow;

export function loadUrlPathFilters(): Promise<UrlPathFilter[]> {
  return loadFilterRows("url_path_filter");
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

export function recordFilterHits(
  hits: ReadonlyMap<string, number>,
): Promise<void> {
  return bumpFilterHits("url_path_filter", hits);
}
