import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_TOP_N,
  WORTH_KNOWING_TOP_N,
  routeSection,
} from "./compose-partition.ts";

// These lock the partition invariant (CLAUDE.md §Invariants #2 +
// §"Observed scorer distribution"): routing is rank-based with a
// low-confidence / weak-evidence override, NOT confidence-primary.

describe("routeSection — rank-based routing", () => {
  const base = { kind: "single" as const, confidence: "high", penaltyFactors: [] };

  test("ranks 1..5 → conversation", () => {
    for (let rank = 1; rank <= CONVERSATION_TOP_N; rank++) {
      expect(routeSection({ ...base, rank })).toBe("conversation");
    }
  });

  test("ranks 6..10 → worth_knowing", () => {
    for (let rank = CONVERSATION_TOP_N + 1; rank <= WORTH_KNOWING_TOP_N; rank++) {
      expect(routeSection({ ...base, rank })).toBe("worth_knowing");
    }
  });

  test("rank 11+ → worth_watching", () => {
    expect(routeSection({ ...base, rank: 11 })).toBe("worth_watching");
    expect(routeSection({ ...base, rank: 99 })).toBe("worth_watching");
  });
});

describe("routeSection — uncertainty override (singles only)", () => {
  test("low confidence demotes a top-ranked single to worth_watching", () => {
    expect(
      routeSection({
        kind: "single",
        rank: 1,
        confidence: "low",
        penaltyFactors: [],
      }),
    ).toBe("worth_watching");
  });

  test("an evidence-weak penalty factor demotes a top-ranked single", () => {
    for (const f of ["unreplicated", "preclinical_only", "insufficient_evidence"]) {
      expect(
        routeSection({
          kind: "single",
          rank: 2,
          confidence: "high",
          penaltyFactors: [f],
        }),
      ).toBe("worth_watching");
    }
  });

  test("medium confidence is NOT a demotion signal (weak signal)", () => {
    // The crux of the invariant: medium is the scorer's default, so it
    // must not push everything into worth_watching.
    expect(
      routeSection({
        kind: "single",
        rank: 1,
        confidence: "medium",
        penaltyFactors: [],
      }),
    ).toBe("conversation");
  });

  test("null confidence does not demote", () => {
    expect(
      routeSection({
        kind: "single",
        rank: 3,
        confidence: null,
        penaltyFactors: [],
      }),
    ).toBe("conversation");
  });

  test("an unrelated penalty factor does not demote", () => {
    expect(
      routeSection({
        kind: "single",
        rank: 4,
        confidence: "high",
        penaltyFactors: ["high_base_rate", "reversible"],
      }),
    ).toBe("conversation");
  });
});

describe("routeSection — arcs always route by rank", () => {
  test("a low-confidence arc still routes by rank, not demoted", () => {
    expect(
      routeSection({
        kind: "arc",
        rank: 1,
        confidence: "low",
        penaltyFactors: ["unreplicated"],
      }),
    ).toBe("conversation");
  });

  test("an arc at rank 11+ still routes to worth_watching by rank", () => {
    expect(
      routeSection({
        kind: "arc",
        rank: 12,
        confidence: "high",
        penaltyFactors: [],
      }),
    ).toBe("worth_watching");
  });
});
