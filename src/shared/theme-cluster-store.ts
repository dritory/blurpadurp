// DB-facing half of narrative clustering. The maths lives in
// theme-cluster.ts (pure, unit-tested); this only fetches centroids and
// hands them over.
//
// Shared by compose.ts (the live pipeline) and the /admin/explore/editor
// sandbox, for the same reason selectEditorPool is: a threshold change
// must be visible in both or the sandbox stops predicting the pipeline.

import { db } from "../db/index.ts";
import { parsePgVector } from "./embedding-utils.ts";
import {
  clusterKeyByTheme,
  clusterThemes,
  type ThemeCluster,
} from "./theme-cluster.ts";

export interface ClusterLoad {
  clusters: ThemeCluster[];
  byTheme: Map<number, string>;
  /** Clusters that actually group something — the ones worth showing a
   *  human or an editor model. Singletons are noise in that view. */
  multiThemeClusters: ThemeCluster[];
}

const EMPTY: ClusterLoad = {
  clusters: [],
  byTheme: new Map(),
  multiThemeClusters: [],
};

/**
 * Cluster the given themes by centroid similarity.
 *
 * Only theme centroids are read — never individual story embeddings.
 * Stories that near-duplicate each other already land on the same theme
 * (score.ts attaches at 0.70 cosine), so the crowding this is built to
 * catch is between themes, and reading a few dozen centroids is far
 * cheaper than pulling an embedding per pool row.
 */
export async function loadThemeClusters(
  themeIds: number[],
  threshold: number,
): Promise<ClusterLoad> {
  const ids = [...new Set(themeIds.map(Number))].filter((n) =>
    Number.isFinite(n),
  );
  if (ids.length === 0) return EMPTY;

  const rows = await db
    .selectFrom("theme")
    .select(["id", "centroid_embedding"])
    .where("id", "in", ids)
    .execute();

  const clusters = clusterThemes(
    rows.map((r) => ({
      theme_id: Number(r.id),
      centroid: parsePgVector(r.centroid_embedding),
    })),
    threshold,
  );

  return {
    clusters,
    byTheme: clusterKeyByTheme(clusters),
    multiThemeClusters: clusters.filter((c) => c.theme_ids.length > 1),
  };
}
