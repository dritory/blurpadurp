import { describe, expect, test } from "bun:test";
import {
  clusterKeyByTheme,
  clusterThemes,
  cosineSimilarity,
} from "./theme-cluster.ts";

// Small hand-built vectors: an angle in 2-D is easy to reason about and
// cosine similarity ignores magnitude, so these read as "how far apart
// are these two themes" without any embedding machinery.
function atAngle(deg: number): number[] {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r)];
}

describe("cosineSimilarity", () => {
  test("identical direction is 1, orthogonal is 0", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  test("unmeasurable inputs read as 0, never as identical", () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });
});

describe("clusterThemes", () => {
  test("groups adjacent arcs and leaves a distant theme alone", () => {
    // 0°/10°/20° are mutually within ~0.94 cosine; 90° is orthogonal.
    const clusters = clusterThemes(
      [
        { theme_id: 1, centroid: atAngle(0) },
        { theme_id: 2, centroid: atAngle(10) },
        { theme_id: 3, centroid: atAngle(20) },
        { theme_id: 9, centroid: atAngle(90) },
      ],
      0.7,
    );
    expect(clusters).toHaveLength(2);
    const byKey = clusterKeyByTheme(clusters);
    expect(byKey.get(1)).toBe(byKey.get(2)!);
    expect(byKey.get(1)).toBe(byKey.get(3)!);
    expect(byKey.get(9)).not.toBe(byKey.get(1)!);
  });

  test("complete linkage refuses to chain through a bridge theme", () => {
    // 0° and 80° are ~0.17 cosine — unrelated. 40° sits within the 0.7
    // bar of both. Single-link would merge all three through it;
    // complete-link must not, because the cluster would then claim two
    // unrelated narratives are one.
    const clusters = clusterThemes(
      [
        { theme_id: 1, centroid: atAngle(0) },
        { theme_id: 2, centroid: atAngle(40) },
        { theme_id: 3, centroid: atAngle(80) },
      ],
      0.7,
    );
    const byKey = clusterKeyByTheme(clusters);
    expect(byKey.get(1)).not.toBe(byKey.get(3)!);
    // The bridge joins exactly one side, and only one side.
    expect(clusters).toHaveLength(2);
  });

  test("themes without a centroid are never merged", () => {
    const clusters = clusterThemes(
      [
        { theme_id: 1, centroid: atAngle(0) },
        { theme_id: 2, centroid: atAngle(2) },
        { theme_id: 3, centroid: null },
        { theme_id: 4, centroid: null },
      ],
      0.7,
    );
    const byKey = clusterKeyByTheme(clusters);
    expect(byKey.get(1)).toBe(byKey.get(2)!);
    expect(byKey.get(3)).not.toBe(byKey.get(4)!);
    expect(byKey.get(3)).not.toBe(byKey.get(1)!);
  });

  test("a threshold above every pair leaves every theme singleton", () => {
    const clusters = clusterThemes(
      [
        { theme_id: 1, centroid: atAngle(0) },
        { theme_id: 2, centroid: atAngle(10) },
      ],
      0.99,
    );
    expect(clusters).toHaveLength(2);
  });

  test("keys are stable regardless of input order", () => {
    const a = clusterThemes(
      [
        { theme_id: 7, centroid: atAngle(10) },
        { theme_id: 3, centroid: atAngle(0) },
        { theme_id: 5, centroid: atAngle(90) },
      ],
      0.7,
    );
    const b = clusterThemes(
      [
        { theme_id: 5, centroid: atAngle(90) },
        { theme_id: 3, centroid: atAngle(0) },
        { theme_id: 7, centroid: atAngle(10) },
      ],
      0.7,
    );
    expect(a).toEqual(b);
    // Key is the lowest member id, so it doesn't move when a later
    // theme joins the cluster.
    expect(a.find((c) => c.theme_ids.includes(7))!.cluster_key).toBe("c3");
  });

  test("empty input is not an error", () => {
    expect(clusterThemes([], 0.7)).toEqual([]);
  });
});
