// Theme-first editor pool selection. Shared between compose.ts (the
// live pipeline) and the admin/explore/editor sandbox (read-only
// "what would the editor see right now"), so a tuning change in pool
// logic is visible in both places without drift.
//
// The shape: gate-passing rows arrive ranked by composite. We group
// them by theme_id, rank themes by max-composite then tier1 total,
// and fill the pool with every member of the top themes until we hit
// the configured pool_size. Stories without a theme become per-row
// singleton buckets that compete on the same axis.

import { countTier1 } from "./source-tiers.ts";

export interface PoolRowShape {
  story_id: number | bigint;
  theme_id: number | null;
  composite: string | number | null;
  source_url: string | null;
  additional_source_urls: string[];
  category_slug?: string | null;
}

export interface PoolEntry<R extends PoolRowShape> {
  row: R;
  tier1: number;
  total: number;
}

export interface PoolBucket<R extends PoolRowShape> {
  themeId: number | null;
  rows: PoolEntry<R>[];
  maxComposite: number;
  tier1Total: number;
}

export interface PoolResult<R extends PoolRowShape> {
  /** Selected stories — every member of every included theme, in
   *  bucket order (best theme first). */
  pool: PoolEntry<R>[];
  /** Themes whose members are in the pool, ranked. */
  included: PoolBucket<R>[];
  /** Themes ranked but cut by pool_size — useful for the sandbox to
   *  show "what's just below the line." */
  excluded: PoolBucket<R>[];
  /** Total passers across all themes (input row count). */
  totalPassers: number;
  /** Distinct themes (incl. singleton-loose buckets). */
  totalThemes: number;
}

export interface PoolOptions {
  /** Cap any single category's themes to this fraction of
   *  maxThemes. 0.5 = max 50% themes from any one category. Set to
   *  1.0 (or greater) to disable capping. Stories without a category
   *  slug share a virtual "—" bucket. */
  maxCategoryFraction?: number;
  /** Story-count safety cap. Stops including more themes once the
   *  cumulative story count would exceed this — protects against a
   *  single runaway theme (50+ members) blowing up the editor input
   *  token budget. Optional; defaults to 200. */
  maxStorySafetyCap?: number;
}

/**
 * Pool selection. `maxThemes` is the primary cap — the editor reasons
 * about themes/arcs, so a theme count gives a more meaningful budget
 * than a story count. The story safety cap (`opts.maxStorySafetyCap`)
 * exists only to protect the LLM context window from one outlier
 * theme with hundreds of members.
 */
export function selectEditorPool<R extends PoolRowShape>(
  rows: R[],
  maxThemes: number,
  opts: PoolOptions = {},
): PoolResult<R> {
  const annotated: PoolEntry<R>[] = rows.map((r) => {
    const allUrls = [
      ...(r.source_url ? [r.source_url] : []),
      ...(r.additional_source_urls ?? []),
    ];
    return { row: r, tier1: countTier1(allUrls), total: allUrls.length };
  });

  const buckets = new Map<string, PoolBucket<R>>();
  for (const a of annotated) {
    const key =
      a.row.theme_id !== null
        ? `t${a.row.theme_id}`
        : `s${a.row.story_id}`;
    const composite =
      a.row.composite !== null ? Number(a.row.composite) : 0;
    const existing = buckets.get(key);
    if (existing === undefined) {
      buckets.set(key, {
        themeId: a.row.theme_id !== null ? Number(a.row.theme_id) : null,
        rows: [a],
        maxComposite: composite,
        tier1Total: a.tier1,
      });
    } else {
      existing.rows.push(a);
      existing.maxComposite = Math.max(existing.maxComposite, composite);
      existing.tier1Total += a.tier1;
    }
  }
  const ranked = [...buckets.values()].sort((a, b) => {
    if (b.maxComposite !== a.maxComposite)
      return b.maxComposite - a.maxComposite;
    return b.tier1Total - a.tier1Total;
  });

  const pool: PoolEntry<R>[] = [];
  const included: PoolBucket<R>[] = [];
  const excluded: PoolBucket<R>[] = [];

  const fraction =
    opts.maxCategoryFraction !== undefined ? opts.maxCategoryFraction : 1.0;
  // Per-category cap measured in THEMES — same unit as maxThemes —
  // since selection is theme-first. Soft cap: the over-represented
  // category's surplus themes go to excluded, freeing slots for the
  // next-best theme of any other category.
  const perCategoryCap = Math.ceil(maxThemes * fraction);
  const perCategoryCount = new Map<string, number>();
  const storySafetyCap = opts.maxStorySafetyCap ?? 200;

  for (const bucket of ranked) {
    if (included.length >= maxThemes) {
      excluded.push(bucket);
      continue;
    }
    if (pool.length >= storySafetyCap) {
      excluded.push(bucket);
      continue;
    }
    const cat = bucket.rows[0]?.row.category_slug ?? "—";
    const used = perCategoryCount.get(cat) ?? 0;
    if (fraction < 1.0 && used >= perCategoryCap) {
      excluded.push(bucket);
      continue;
    }
    pool.push(...bucket.rows);
    included.push(bucket);
    perCategoryCount.set(cat, used + 1);
  }

  return {
    pool,
    included,
    excluded,
    totalPassers: annotated.length,
    totalThemes: buckets.size,
  };
}
