// Title regex classifier, driven by the title_regex_filter table.
// Mirrors src/shared/url-noise.ts — same two-mode design (block at
// ingest vs tag for audit) but matches against story.title via
// JS RegExp instead of URL substrings.
//
// The load + hit-recording DB plumbing lives in filter-store.ts (shared
// with url-noise.ts); this module owns only the regex match strategy and
// its compilation. Regex compilation is done once per ingest run during
// loadTitleRegexFilters, not per title. Invalid patterns are logged and
// skipped so a single bad row in the table never aborts ingest.

import {
  bumpFilterHits,
  loadFilterRows,
  type FilterMatch,
  type FilterMode,
} from "./filter-store.ts";

export type { FilterMode };
export type TitleMatch = FilterMatch;

export interface TitleRegexFilter {
  pattern: string;
  mode: FilterMode;
  regex: RegExp;
}

export async function loadTitleRegexFilters(): Promise<TitleRegexFilter[]> {
  const rows = await loadFilterRows("title_regex_filter");
  const out: TitleRegexFilter[] = [];
  for (const r of rows) {
    try {
      out.push({
        pattern: r.pattern,
        mode: r.mode,
        regex: new RegExp(r.pattern, "i"),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[title-noise] skipping invalid regex ${JSON.stringify(r.pattern)}: ${msg}`,
      );
    }
  }
  return out;
}

export function classifyTitle(
  title: string,
  filters: readonly TitleRegexFilter[],
): TitleMatch | null {
  if (title.length === 0) return null;
  for (const f of filters) {
    if (f.regex.test(title)) {
      return { pattern: f.pattern, mode: f.mode };
    }
  }
  return null;
}

// Compiles a candidate pattern. Used by /admin/title-filters/add to
// reject bad patterns at insert time rather than letting them sit in
// the table and get skipped at every ingest run.
export function validateTitleRegex(pattern: string): { ok: true } | { ok: false; error: string } {
  try {
    new RegExp(pattern, "i");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function recordTitleFilterHits(
  hits: ReadonlyMap<string, number>,
): Promise<void> {
  return bumpFilterHits("title_regex_filter", hits);
}
