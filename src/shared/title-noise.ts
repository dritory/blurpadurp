// Title regex classifier, driven by the title_regex_filter table.
// Mirrors src/shared/url-noise.ts — same two-mode design (block at
// ingest vs tag for audit) but matches against story.title via
// JS RegExp instead of URL substrings.
//
// Regex compilation is done once per ingest run during loadFilters,
// not per URL. Invalid patterns are logged and skipped so a single
// bad row in the table never aborts ingest.

import { sql } from "kysely";
import { db } from "../db/index.ts";

export type FilterMode = "block" | "tag";

export interface TitleRegexFilter {
  pattern: string;
  mode: FilterMode;
  regex: RegExp;
}

export interface TitleMatch {
  pattern: string;
  mode: FilterMode;
}

export async function loadTitleRegexFilters(): Promise<TitleRegexFilter[]> {
  const rows = await db
    .selectFrom("title_regex_filter")
    .select(["pattern", "mode"])
    .execute();
  const out: TitleRegexFilter[] = [];
  for (const r of rows) {
    try {
      out.push({
        pattern: r.pattern,
        mode: r.mode === "block" ? "block" : "tag",
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

export async function recordTitleFilterHits(
  hits: ReadonlyMap<string, number>,
): Promise<void> {
  if (hits.size === 0) return;
  for (const [pattern, n] of hits) {
    if (n <= 0) continue;
    await db
      .updateTable("title_regex_filter")
      .set({ hits: sql`hits + ${n}` })
      .where("pattern", "=", pattern)
      .execute();
  }
}
