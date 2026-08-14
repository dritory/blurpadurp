// Narrative clustering over theme centroids.
//
// Themes are the unit the editor reasons about, but one news narrative
// routinely spans several of them. "US–Iran escalation", "Hormuz
// shipping", and "oil price spike" are three distinct arcs that a
// reader experiences as a single story — and nothing downstream could
// see that, so a week with one dominant narrative filled the brief with
// it: the same event told four ways across four "different" themes.
//
// This groups themes one level up, for balance accounting only. It
// deliberately does NOT merge them. reattach.ts merges themes at 0.85
// cosine and the pairs we care about sit below that bar — mig 031 calls
// them "semantically adjacent but distinct arcs at 0.70", which is
// exactly the population this module is built to catch. Theme identity,
// arc detection, and timelines are untouched; a cluster is a hint about
// crowding, not a claim that two arcs are the same arc.
//
// Linkage is COMPLETE, not single. Single-link would chain — A~B, B~C,
// and suddenly an unrelated A and C share a cluster through a bridge
// theme, which at a 0.70 bar over twenty themes is a real risk. Complete
// link requires every cross-pair to clear the threshold, so a cluster is
// a genuinely tight narrative. It costs O(n^3) in the worst case; n is
// the pool's distinct-theme count (~20-40), so that is nothing.

export interface ClusterableTheme {
  theme_id: number;
  /** Parsed theme.centroid_embedding. Null centroids are never merged —
   *  a theme we can't measure gets its own cluster rather than being
   *  guessed into someone else's. */
  centroid: number[] | null;
}

export interface ThemeCluster {
  /** Stable key: `c<lowest member theme_id>`. */
  cluster_key: string;
  theme_ids: number[];
}

/** Cosine similarity. Returns 0 for empty, length-mismatched, or
 *  zero-magnitude vectors — all "we can't tell", which must never read
 *  as "these are the same". */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Complete-link agglomerative clustering over theme centroids.
 *
 * Themes are processed in ascending theme_id order and merges are taken
 * best-pair-first, so the output is deterministic for a given input —
 * which matters because the cluster keys end up in the editor's prompt,
 * and a prompt that reshuffles between identical runs would blow the
 * composer/editor input-hash cache for no reason.
 */
export function clusterThemes(
  themes: ClusterableTheme[],
  threshold: number,
): ThemeCluster[] {
  const sorted = [...themes].sort((a, b) => a.theme_id - b.theme_id);
  // Themes without a centroid can never merge; keep them aside so they
  // don't cost O(n^2) similarity lookups on every pass.
  const measurable = sorted.filter((t) => t.centroid !== null);
  const loose = sorted.filter((t) => t.centroid === null);

  const centroidById = new Map<number, number[]>(
    measurable.map((t) => [t.theme_id, t.centroid!] as const),
  );
  const sim = new Map<string, number>();
  const pairSim = (a: number, b: number): number => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const hit = sim.get(key);
    if (hit !== undefined) return hit;
    const value = cosineSimilarity(
      centroidById.get(a)!,
      centroidById.get(b)!,
    );
    sim.set(key, value);
    return value;
  };

  let groups: number[][] = measurable.map((t) => [t.theme_id]);

  for (;;) {
    let bestI = -1;
    let bestJ = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        // Complete linkage: the pair's score is its WEAKEST cross-edge.
        let weakest = Number.POSITIVE_INFINITY;
        for (const a of groups[i]!) {
          for (const b of groups[j]!) {
            const s = pairSim(a, b);
            if (s < weakest) weakest = s;
            if (weakest < threshold) break;
          }
          if (weakest < threshold) break;
        }
        if (weakest < threshold) continue;
        if (weakest > bestScore) {
          bestScore = weakest;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestI === -1) break;
    const merged = [...groups[bestI]!, ...groups[bestJ]!].sort((a, b) => a - b);
    groups = groups.filter((_, idx) => idx !== bestI && idx !== bestJ);
    groups.push(merged);
  }

  const all = [
    ...groups,
    ...loose.map((t) => [t.theme_id]),
  ];
  return all
    .map((theme_ids) => ({
      cluster_key: `c${theme_ids[0]}`,
      theme_ids,
    }))
    .sort((a, b) => a.theme_ids[0]! - b.theme_ids[0]!);
}

/** theme_id → cluster_key, for stamping onto pool rows. */
export function clusterKeyByTheme(
  clusters: ThemeCluster[],
): Map<number, string> {
  const out = new Map<number, string>();
  for (const c of clusters) {
    for (const tid of c.theme_ids) out.set(tid, c.cluster_key);
  }
  return out;
}
