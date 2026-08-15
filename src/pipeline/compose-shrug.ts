// Worth a shrug: which failed-gate hype stories fill the section's five
// slots, and which penalty label each one carries.
//
// Same principle as compose-diversity.ts (CLAUDE.md §Invariants #2):
// hard structure beats prompt instructions. The prompt has always asked
// for five *different* dismissals and it shipped five copies of one
// sentence, because the input it was reading was itself monotonous —
// five rows, all tagged "48-hour controversy".
//
// That was a selection artifact, not a writing one. The three
// qualifying penalty factors are not equally syndicated:
// controversy_flash is precisely the marker of a story that wire
// services and aggregators pile onto, so ranking candidates by
// source_count — "how hard did the algorithm push this" — is very
// nearly a controversy_flash sort. In-circle hype (a niche launch
// covered by two trade outlets) loses that race every week by
// construction, which is why the section never saw one.
//
// So the cap is spent round-robin across the factors instead: take the
// best-ranked candidate offering a factor this cycle hasn't used yet,
// and when all three have been used, start a fresh cycle. Source count
// still orders within a factor, so the loudest example of each kind of
// nonsense is the one that gets written about.
//
// The chosen factor is returned as the row's label rather than left to
// the composer, for the same reason the composer doesn't choose its own
// section: a row carrying three factors and no instruction is an
// invitation to pick whichever one the joke wants, and the joke wants
// the same one every time.
//
// Pure: no DB, no clock. Data can still force a monoculture — a week
// where every candidate is controversy_flash gets five of them, and
// that is honest — but the ranking no longer manufactures one.

/** Penalty factors that qualify a scored, failed-gate story for the
 *  Worth a shrug section. These are the "hype" markers from the scorer
 *  rubric: items the algorithm pushed that this brief refuses. Order is
 *  the round-robin's tie-break, so it is deliberate: the two rarer
 *  factors sit ahead of the one that would otherwise dominate. */
export const SHRUG_PENALTY_FACTORS = [
  "in_circle_hype",
  "manufactured_hype",
  "controversy_flash",
] as const;

/** Reader-facing tag per factor. Anything unmapped degrades to the
 *  factor key with underscores stripped. */
const PENALTY_LABELS: Record<string, string> = {
  in_circle_hype: "in-circle hype",
  manufactured_hype: "manufactured hype",
  controversy_flash: "48-hour controversy",
};

export function humanizePenaltyFactor(f: string): string {
  return PENALTY_LABELS[f] ?? f.replace(/_/g, " ");
}

export interface ShrugCandidate {
  story_id: number;
  /** Raw factor keys (not humanized), at least one of SHRUG_PENALTY_FACTORS. */
  penalty_factors: string[];
  source_count: number;
}

export interface ShrugSelection<T> {
  candidate: T;
  /** The factor this row's label is drawn from. */
  label_factor: string;
}

/** Order a candidate's factors by the canonical rota, unknown ones last. */
function orderedFactors(c: ShrugCandidate, rota: readonly string[]): string[] {
  const rank = (f: string): number => {
    const i = rota.indexOf(f);
    return i === -1 ? rota.length : i;
  };
  return [...c.penalty_factors].sort((a, b) => rank(a) - rank(b));
}

/**
 * Choose up to `limit` shrug rows, spreading labels across the
 * qualifying penalty factors.
 *
 * Ranking within a factor is by source_count descending (story_id
 * ascending as a deterministic tie-break, so two runs on the same pool
 * produce the same section — the composer is cached on a hash of its
 * rendered input, and an unstable order would miss for no reason).
 */
export function selectShrugCandidates<T extends ShrugCandidate>(
  candidates: readonly T[],
  limit: number,
  rota: readonly string[] = SHRUG_PENALTY_FACTORS,
): ShrugSelection<T>[] {
  const pool = [...candidates].sort(
    (a, b) => b.source_count - a.source_count || a.story_id - b.story_id,
  );

  const picked: ShrugSelection<T>[] = [];
  let usedThisCycle = new Set<string>();

  while (picked.length < limit && pool.length > 0) {
    let index = -1;
    let factor: string | null = null;

    for (let i = 0; i < pool.length; i++) {
      const fresh = orderedFactors(pool[i]!, rota).find(
        (f) => !usedThisCycle.has(f),
      );
      if (fresh !== undefined) {
        index = i;
        factor = fresh;
        break;
      }
    }

    if (index === -1) {
      // Every remaining candidate only offers factors this cycle has
      // already spent. Start a new cycle and try once more; if the
      // cycle was already empty, the pool has nothing rota-shaped left
      // and we fall back to plain rank order. The `continue` cannot
      // spin: it only runs when the set is non-empty, and it empties it.
      if (usedThisCycle.size > 0) {
        usedThisCycle = new Set();
        continue;
      }
      index = 0;
      factor = orderedFactors(pool[0]!, rota)[0] ?? "";
    }

    const [candidate] = pool.splice(index, 1);
    picked.push({ candidate: candidate!, label_factor: factor! });
    usedThisCycle.add(factor!);
  }

  return picked;
}
