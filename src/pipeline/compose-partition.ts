// Section routing for composed picks — extracted from compose.ts so the
// partition invariant is unit-testable in isolation.
//
// Encodes CLAUDE.md §Invariants #2 ("the composer does not decide section
// placement") together with §"Observed scorer distribution": routing is
// rank-based with a low-confidence / weak-evidence safety override — it is
// NOT confidence-primary. The scorer's confidence is weak signal (medium is
// its default), so confidence can only DEMOTE a single pick to worth_watching;
// it never gates the main body.

export type Section = "conversation" | "worth_knowing" | "worth_watching";

// Rank thresholds: picks ranked 1..5 → conversation, 6..10 → worth_knowing,
// 11+ → worth_watching.
export const CONVERSATION_TOP_N = 5;
export const WORTH_KNOWING_TOP_N = 10;

// Evidence-weak factors that demote a single pick to worth_watching
// regardless of rank. Mirrors the scoring rubric vocabulary — keep in sync
// with scoring-schema.ts (penaltyFactors + uncertaintyFactors).
export const WATCH_PENALTY_FACTORS: ReadonlySet<string> = new Set([
  "unreplicated",
  "preclinical_only",
  "insufficient_evidence",
]);

export interface RoutingInput {
  // Arcs always route by rank — continuing threads are never "still
  // developing" placeholders, so the uncertainty override never applies.
  kind: "single" | "arc";
  rank: number;
  // Lead story's point-in-time confidence and penalty factors.
  confidence: string | null;
  penaltyFactors: readonly string[];
}

export function routeSection(input: RoutingInput): Section {
  const matchesWatch = input.penaltyFactors.some((f) =>
    WATCH_PENALTY_FACTORS.has(f),
  );
  const uncertaintyOverride =
    input.kind === "single" && (input.confidence === "low" || matchesWatch);
  if (uncertaintyOverride) return "worth_watching";
  if (input.rank <= CONVERSATION_TOP_N) return "conversation";
  if (input.rank <= WORTH_KNOWING_TOP_N) return "worth_knowing";
  return "worth_watching";
}
