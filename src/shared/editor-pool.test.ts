import { describe, expect, test } from "bun:test";
import { selectEditorPool, type PoolRowShape } from "./editor-pool.ts";

// Minimal row factory matching PoolRowShape.
function row(p: {
  id: number;
  theme?: number | null;
  composite?: number;
  cat?: string | null;
  urls?: string[];
  cluster?: string | null;
}): PoolRowShape {
  return {
    story_id: p.id,
    theme_id: p.theme ?? null,
    composite: p.composite ?? 0,
    source_url: p.urls?.[0] ?? null,
    additional_source_urls: p.urls?.slice(1) ?? [],
    category_slug: p.cat ?? null,
    cluster_key: p.cluster ?? null,
  };
}

describe("selectEditorPool", () => {
  test("groups stories by theme and includes every member of a theme", () => {
    const rows = [
      row({ id: 1, theme: 100, composite: 9 }),
      row({ id: 2, theme: 100, composite: 3 }),
      row({ id: 3, theme: 200, composite: 5 }),
    ];
    const res = selectEditorPool(rows, 10);
    expect(res.totalThemes).toBe(2);
    expect(res.totalPassers).toBe(3);
    expect(res.pool.map((p) => Number(p.row.story_id)).sort()).toEqual([1, 2, 3]);
  });

  test("untheme'd stories become singleton buckets", () => {
    const rows = [
      row({ id: 1, theme: null, composite: 4 }),
      row({ id: 2, theme: null, composite: 8 }),
    ];
    const res = selectEditorPool(rows, 10);
    expect(res.totalThemes).toBe(2);
    expect(res.included.every((b) => b.themeId === null)).toBe(true);
  });

  test("ranks themes by max-composite, then tier1 as tiebreak", () => {
    const rows = [
      row({ id: 1, theme: 100, composite: 5 }),
      // theme 200 ties on composite but has a tier-1 source
      row({ id: 2, theme: 200, composite: 5, urls: ["https://reuters.com/a"] }),
    ];
    const res = selectEditorPool(rows, 10);
    expect(res.included[0]!.themeId).toBe(200); // tier1 tiebreak wins
  });

  test("maxThemes caps how many themes enter the pool", () => {
    const rows = [
      row({ id: 1, theme: 100, composite: 9 }),
      row({ id: 2, theme: 200, composite: 8 }),
      row({ id: 3, theme: 300, composite: 7 }),
    ];
    const res = selectEditorPool(rows, 2);
    expect(res.included).toHaveLength(2);
    expect(res.excluded).toHaveLength(1);
    expect(res.included.map((b) => b.themeId)).toEqual([100, 200]);
  });

  test("category fraction soft-caps themes from one over-represented category", () => {
    const rows = [
      row({ id: 1, theme: 100, composite: 9, cat: "politics" }),
      row({ id: 2, theme: 200, composite: 8, cat: "politics" }),
      row({ id: 3, theme: 300, composite: 7, cat: "politics" }),
      row({ id: 4, theme: 400, composite: 6, cat: "science" }),
    ];
    // cap = ceil(4 * 0.5) = 2 politics themes max
    const res = selectEditorPool(rows, 4, { maxCategoryFraction: 0.5 });
    const politics = res.included.filter(
      (b) => b.rows[0]!.row.category_slug === "politics",
    );
    expect(politics).toHaveLength(2);
    expect(res.included.some((b) => b.rows[0]!.row.category_slug === "science")).toBe(
      true,
    );
  });

  test("cluster fraction caps themes from one dominant narrative", () => {
    // Four themes off one running story, each legitimately high
    // composite, plus one unrelated theme ranked below all of them.
    // Ranking alone admits all four and buries the fifth.
    const rows = [
      row({ id: 1, theme: 100, composite: 9, cluster: "c100" }),
      row({ id: 2, theme: 200, composite: 8, cluster: "c100" }),
      row({ id: 3, theme: 300, composite: 7, cluster: "c100" }),
      row({ id: 4, theme: 400, composite: 6, cluster: "c100" }),
      row({ id: 5, theme: 500, composite: 2, cluster: "c500" }),
    ];
    // cap = ceil(4 * 0.5) = 2 themes from cluster c100
    const res = selectEditorPool(rows, 4, { maxClusterFraction: 0.5 });
    expect(res.included.map((b) => b.themeId)).toEqual([100, 200, 500]);
    expect(res.excluded.map((b) => b.themeId)).toEqual([300, 400]);
  });

  test("unclustered themes are never capped against each other", () => {
    const rows = [
      row({ id: 1, theme: 100, composite: 9 }),
      row({ id: 2, theme: 200, composite: 8 }),
      row({ id: 3, theme: 300, composite: 7 }),
    ];
    const res = selectEditorPool(rows, 10, { maxClusterFraction: 0.1 });
    expect(res.included).toHaveLength(3);
  });

  test("story safety cap (soft) stops admitting once the pool reaches the cap", () => {
    // The cap is checked before each theme, so the first theme can overshoot
    // it; the next theme is then excluded. Top theme has 5 stories, cap = 4:
    // theme 100 admitted (pool 5 >= 4), theme 200 excluded.
    const rows = [
      row({ id: 1, theme: 100, composite: 9 }),
      row({ id: 2, theme: 100, composite: 9 }),
      row({ id: 3, theme: 100, composite: 9 }),
      row({ id: 4, theme: 100, composite: 9 }),
      row({ id: 5, theme: 100, composite: 9 }),
      row({ id: 6, theme: 200, composite: 8 }),
      row({ id: 7, theme: 200, composite: 8 }),
    ];
    const res = selectEditorPool(rows, 10, { maxStorySafetyCap: 4 });
    expect(res.included.map((b) => b.themeId)).toEqual([100]);
    expect(res.excluded.map((b) => b.themeId)).toEqual([200]);
    expect(res.pool).toHaveLength(5);
  });
});
