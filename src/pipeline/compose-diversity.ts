// Post-editor diversity enforcement.
//
// CLAUDE.md §Invariants #2 is the principle this follows: hard structure
// beats prompt instructions. The editor prompt has asked for topic
// balance since v0.1 ("4+ stories on the exact same angle is crowding")
// and it still shipped issues whose entire lead section was one
// narrative told four ways. A prompt cannot be the only thing standing
// between the reader and a monotopic brief, for the same reason the
// composer doesn't choose its own sections.
//
// So the caps live here, in TypeScript, applied to the editor's output
// before partitioning. Two of them:
//
//   1. maxPicksPerCluster — how much of the WHOLE brief one narrative
//      may occupy. Surplus is cut, not demoted: demoting just relocates
//      the saturation to Worth knowing, and a brief that runs short is
//      the intended failure mode here (CLAUDE.md §Invariants #1).
//   2. maxLeadPerCluster — how much of the CONVERSATION section (ranks
//      1..CONVERSATION_TOP_N) one narrative may occupy. Surplus is
//      demoted rather than cut; the story still belongs in the issue,
//      just not stacked at the top.
//
// The lead cap is best-effort by construction. It works by promoting
// other clusters' picks ahead of a saturated one, so its power is
// bounded by how many other picks exist: when the pool genuinely holds
// nothing else, the section fills with the dominant narrative anyway and
// `relaxed` records that it happened. That is the intended behaviour —
// the goal is to stop a narrative crowding out competitors that EXIST,
// not to manufacture variety that doesn't, and CONVERSATION_TOP_N is a
// structural constant rather than something to shrink on a quiet week.
//
// The whole-issue cap has no such escape: it cuts, and a short issue is
// an acceptable outcome (CLAUDE.md §Invariants #1). Cut picks keep
// published_to_reader = false, so they return to next week's pool rather
// than being lost.

import type { NormalizedPick } from "../shared/editor-schema.ts";
import { CONVERSATION_TOP_N } from "./compose-partition.ts";

export interface DiversityOptions {
  /** Max picks from one narrative cluster across the entire issue.
   *  Surplus picks are cut. */
  maxPicksPerCluster: number;
  /** Max picks from one narrative cluster inside the conversation
   *  section. Surplus picks are demoted below the section boundary. */
  maxLeadPerCluster: number;
  /** Size of the conversation section. Defaults to the partition
   *  module's threshold so the two can't drift. */
  conversationSlots?: number;
}

export interface DiversityCut {
  lead_story_id: number;
  cluster_key: string;
  reason: string;
}

export interface DiversityResult {
  /** Kept picks, re-ranked to a contiguous 1..N in their new order. */
  picks: NormalizedPick[];
  /** Picks removed by the whole-issue cap. */
  cuts: DiversityCut[];
  /** Lead-story ids that were demoted out of the conversation section. */
  demoted: number[];
  /** True when the lead cap could not be honoured because no other
   *  cluster had a pick left to promote — a genuinely monotopic week
   *  rather than a crowding failure. Worth logging: it's the signal that
   *  the week itself was thin, not that the caps misfired. */
  relaxed: boolean;
}

/**
 * Apply the cluster caps to a ranked pick list.
 *
 * `clusterOf` maps a pick's lead_story_id to its narrative cluster key.
 * Picks whose cluster is unknown are treated as their own cluster —
 * an unmeasurable story is never assumed to be crowding.
 *
 * Pure: no DB, no clock. The whole point is that this is unit-testable
 * in isolation, like routeSection.
 */
export function diversifyPicks(
  picks: NormalizedPick[],
  clusterOf: (leadStoryId: number) => string | null,
  opts: DiversityOptions,
): DiversityResult {
  const slots = opts.conversationSlots ?? CONVERSATION_TOP_N;
  const keyFor = (p: NormalizedPick): string =>
    clusterOf(p.lead_story_id) ?? `lead:${p.lead_story_id}`;

  const sorted = [...picks].sort((a, b) => a.rank - b.rank);

  // Pass 1 — whole-issue cap. Ranked order means the picks a cluster
  // keeps are the ones the editor rated highest, so we cut its weakest
  // representatives rather than an arbitrary subset.
  const kept: NormalizedPick[] = [];
  const cuts: DiversityCut[] = [];
  const seenPerCluster = new Map<string, number>();
  for (const p of sorted) {
    const key = keyFor(p);
    const seen = seenPerCluster.get(key) ?? 0;
    if (seen >= opts.maxPicksPerCluster) {
      cuts.push({
        lead_story_id: p.lead_story_id,
        cluster_key: key,
        reason: `cluster ${key} already has ${opts.maxPicksPerCluster} picks in this issue`,
      });
      continue;
    }
    seenPerCluster.set(key, seen + 1);
    kept.push(p);
  }

  // Pass 2 — lead cap. Greedily fill the conversation section with the
  // best-ranked pick whose cluster still has room, preserving relative
  // order within a cluster. Everything not selected keeps its relative
  // order behind the head, so a demoted pick lands at the top of Worth
  // knowing rather than at the bottom of the issue.
  const head: NormalizedPick[] = [];
  const remainder = [...kept];
  const headPerCluster = new Map<string, number>();
  let relaxed = false;

  while (head.length < slots && remainder.length > 0) {
    const idx = remainder.findIndex(
      (p) => (headPerCluster.get(keyFor(p)) ?? 0) < opts.maxLeadPerCluster,
    );
    if (idx === -1) {
      // No cluster has room: every remaining pick belongs to a narrative
      // that already owns its share of the lead. Nothing left to promote,
      // so the constraint is unsatisfiable — record it and stop.
      relaxed = true;
      break;
    }
    const [p] = remainder.splice(idx, 1);
    const key = keyFor(p!);
    headPerCluster.set(key, (headPerCluster.get(key) ?? 0) + 1);
    head.push(p!);
  }
  // Top up the head from what's left. This does NOT change the output
  // order — head and remainder are concatenated below, so moving an item
  // between them is invisible there. It exists so `head` is the true set
  // of lead-section picks, which is what `demoted` is measured against;
  // without it a pick that stayed in the lead would be reported as
  // demoted out of it.
  if (relaxed) {
    while (head.length < slots && remainder.length > 0) {
      head.push(remainder.shift()!);
    }
  }

  const ordered = [...head, ...remainder];
  const headIds = new Set(head.map((p) => p.lead_story_id));
  const demoted = kept
    .slice(0, Math.min(slots, kept.length))
    .filter((p) => !headIds.has(p.lead_story_id))
    .map((p) => p.lead_story_id);

  return {
    picks: ordered.map((p, i) => ({ ...p, rank: i + 1 })),
    cuts,
    demoted,
    relaxed,
  };
}
