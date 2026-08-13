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
// The rule this encodes: a dominant narrative should be SPREAD DOWN the
// brief, not stacked at the top. One item in the conversation, one in
// Worth knowing, one in Worth watching reads as a story the brief is
// following. Five in the conversation reads as a brief with one subject.
// Same picks either way — the difference is entirely placement, which is
// why placement is what this fixes.
//
// Two caps:
//
//   1. maxPerSectionPerCluster — how many picks one narrative may hold
//      in any ONE section. This is the load-bearing one. Surplus is
//      pushed into the next section, not cut: the story earned its place
//      in the issue, it just shouldn't own the top of it.
//   2. maxPicksPerCluster — a whole-issue backstop. Surplus is cut, and
//      a brief that runs short is an acceptable outcome (CLAUDE.md
//      §Invariants #1). With the per-section cap doing the real work
//      this rarely binds; it exists so a 9-story cluster can't ride the
//      spread all the way down the issue.
//
// Cut picks keep published_to_reader = false, so they return to next
// week's pool rather than being lost.
//
// The spread is best-effort by construction. It works by promoting other
// clusters' picks ahead of a saturated one, so its power is bounded by
// how many other picks exist. Sections are fixed-size (routing is
// rank-based — see compose-partition.ts), so a section that cannot be
// filled under the cap gets filled over it rather than left short:
// CONVERSATION_TOP_N is a structural constant, not something to shrink
// on a thin week. `relaxed` records when that happened, which is the
// signal that the week itself was monotopic rather than that the caps
// misfired.

import type { NormalizedPick } from "../shared/editor-schema.ts";
import {
  CONVERSATION_TOP_N,
  WORTH_KNOWING_TOP_N,
} from "./compose-partition.ts";

// Capacity of each bounded section, derived from the partition module's
// rank thresholds so the two can't drift. Worth watching is the
// unbounded tail and isn't listed: everything left flows into it, and a
// cap there would have nowhere to push surplus to.
export const BOUNDED_SECTION_SIZES: readonly number[] = [
  CONVERSATION_TOP_N,
  WORTH_KNOWING_TOP_N - CONVERSATION_TOP_N,
];

export interface DiversityOptions {
  /** Max picks from one narrative cluster across the entire issue.
   *  Surplus picks are cut. */
  maxPicksPerCluster: number;
  /** Max picks from one narrative cluster within a single section.
   *  Surplus is pushed down into the next section. */
  maxPerSectionPerCluster: number;
  /** Bounded section capacities, in order. Defaults to the partition
   *  module's thresholds. */
  sectionSizes?: readonly number[];
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
  /** Lead-story ids pushed into a later section than pure rank order
   *  would have given them. */
  movedDown: number[];
  /** True when a bounded section had to be filled past the per-section
   *  cap because no other cluster had a pick left to promote. */
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
  const sizes = opts.sectionSizes ?? BOUNDED_SECTION_SIZES;
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

  // Pass 2 — spread. Fill each bounded section in turn with the
  // best-ranked pick whose cluster still has room there. A pick that is
  // blocked stays in the queue and gets its shot at the next section, so
  // relative order within a cluster is preserved and the surplus lands
  // as high as it legitimately can rather than at the bottom.
  const ordered: NormalizedPick[] = [];
  const queue = [...kept];
  let relaxed = false;

  for (const size of sizes) {
    const usedInSection = new Map<string, number>();
    for (let placed = 0; placed < size && queue.length > 0; placed++) {
      let idx = queue.findIndex(
        (p) =>
          (usedInSection.get(keyFor(p)) ?? 0) < opts.maxPerSectionPerCluster,
      );
      if (idx === -1) {
        // Every remaining pick belongs to a narrative that already owns
        // its share of this section. Sections are fixed-size, so there
        // is no "leave it short" option — take the best-ranked pick and
        // record that the cap could not be honoured.
        idx = 0;
        relaxed = true;
      }
      const [p] = queue.splice(idx, 1);
      const key = keyFor(p!);
      usedInSection.set(key, (usedInSection.get(key) ?? 0) + 1);
      ordered.push(p!);
    }
  }
  // Worth watching: the unbounded tail takes whatever is left, in order.
  ordered.push(...queue);

  // Which picks ended up in a later section than pure rank order would
  // have put them. Reported for the compose log, not acted on.
  const movedDown: number[] = [];
  const originalIndex = new Map(
    kept.map((p, i) => [p.lead_story_id, i] as const),
  );
  for (let i = 0; i < ordered.length; i++) {
    const before = originalIndex.get(ordered[i]!.lead_story_id);
    if (before === undefined) continue;
    if (sectionIndex(i, sizes) > sectionIndex(before, sizes)) {
      movedDown.push(ordered[i]!.lead_story_id);
    }
  }

  return {
    picks: ordered.map((p, i) => ({ ...p, rank: i + 1 })),
    cuts,
    movedDown,
    relaxed,
  };
}

/** Which section a zero-based position falls in. The index past the last
 *  bounded section is the unbounded tail. */
function sectionIndex(position: number, sizes: readonly number[]): number {
  let remaining = position;
  for (let i = 0; i < sizes.length; i++) {
    if (remaining < sizes[i]!) return i;
    remaining -= sizes[i]!;
  }
  return sizes.length;
}
