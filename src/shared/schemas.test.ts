import { describe, expect, test } from "bun:test";
import { ScorerOutputSchema } from "./scoring-schema.ts";
import {
  ComposerInputSchema,
  ComposerOutputSchema,
} from "./composer-schema.ts";
import {
  EditorInputSchema,
  EditorOutputSchema,
  normalizePick,
} from "./editor-schema.ts";

// A minimal valid scorer output; tests clone + mutate it.
function baseScorerOutput(): unknown {
  return {
    classification: {
      category: "technology",
      theme_continuation_of: null,
      early_reject: false,
      reject_reason: null,
    },
    reasoning: {
      base_rate_per_year: 2,
      retrodiction_12mo: "still discussed",
      steelman_trivial: "minor",
      steelman_important: "major",
      factors: { trigger: [], penalty: [], uncertainty: [] },
      theme_relationship: "new_theme",
      confidence: "medium",
    },
    scores: {
      zeitgeist: 4,
      half_life: 3,
      reach: 4,
      non_obviousness: 2,
      structural_importance: 3,
      composite: 11.2,
    },
    summary: "a thing happened",
  };
}

describe("ScorerOutputSchema", () => {
  test("parses a well-formed output", () => {
    const r = ScorerOutputSchema.parse(baseScorerOutput());
    expect(r.classification.category).toBe("technology");
    expect(r.scores.zeitgeist).toBe(4);
  });

  test("drops out-of-vocab factor tags rather than failing", () => {
    const raw = baseScorerOutput() as any;
    raw.reasoning.factors.trigger = ["novel_finding", "totally_made_up"];
    raw.reasoning.factors.penalty = ["unreplicated", "bogus_penalty"];
    raw.reasoning.factors.uncertainty = ["no_precedent", "invented"];
    const r = ScorerOutputSchema.parse(raw);
    expect(r.reasoning.factors.trigger).toEqual(["novel_finding"]);
    expect(r.reasoning.factors.penalty).toEqual(["unreplicated"]);
    expect(r.reasoning.factors.uncertainty).toEqual(["no_precedent"]);
  });

  test("coerces an unknown category to null", () => {
    const raw = baseScorerOutput() as any;
    raw.classification.category = "astrology";
    expect(ScorerOutputSchema.parse(raw).classification.category).toBeNull();
  });

  test("coerces null/missing summary and reasoning strings to empty", () => {
    const raw = baseScorerOutput() as any;
    raw.summary = null;
    delete raw.reasoning.retrodiction_12mo;
    raw.reasoning.steelman_trivial = null;
    const r = ScorerOutputSchema.parse(raw);
    expect(r.summary).toBe("");
    expect(r.reasoning.retrodiction_12mo).toBe("");
    expect(r.reasoning.steelman_trivial).toBe("");
  });

  test("coerces null/missing base_rate_per_year to 0", () => {
    const raw = baseScorerOutput() as any;
    raw.reasoning.base_rate_per_year = null;
    expect(ScorerOutputSchema.parse(raw).reasoning.base_rate_per_year).toBe(0);
  });

  test("rejects an out-of-range score", () => {
    const raw = baseScorerOutput() as any;
    raw.scores.zeitgeist = 9;
    expect(ScorerOutputSchema.safeParse(raw).success).toBe(false);
  });
});

describe("ComposerOutputSchema", () => {
  test("accepts a normal title", () => {
    const r = ComposerOutputSchema.parse({
      title: "The week in review",
      markdown: "# hi",
      html: "<h1>hi</h1>",
    });
    expect(r.title).toBe("The week in review");
  });

  test("rejects an empty title", () => {
    expect(
      ComposerOutputSchema.safeParse({ title: "", markdown: "", html: "" })
        .success,
    ).toBe(false);
  });

  test("rejects a title past the 120-char cap", () => {
    expect(
      ComposerOutputSchema.safeParse({
        title: "x".repeat(121),
        markdown: "",
        html: "",
      }).success,
    ).toBe(false);
  });
});

describe("ComposerInputSchema", () => {
  test("accepts empty section arrays (silence is a feature)", () => {
    const r = ComposerInputSchema.parse({
      week_of: "2026-06-05",
      conversation: [],
      worth_knowing: [],
      worth_watching: [],
      shrug: [],
      synthesis_themes: [],
      theme_timelines: [],
    });
    expect(r.conversation).toEqual([]);
  });
});

describe("EditorOutputSchema + normalizePick", () => {
  test("normalizes a single-story pick to a length-1 array", () => {
    const out = EditorOutputSchema.parse({
      picks: [{ story_id: 42, rank: 1, reason: "matters" }],
      cuts_summary: "cut the rest",
    });
    const n = normalizePick(out.picks[0]!);
    expect(n.is_arc).toBe(false);
    expect(n.story_ids).toEqual([42]);
    expect(n.lead_story_id).toBe(42);
  });

  test("normalizes an arc pick, preserving the constituent ids", () => {
    const out = EditorOutputSchema.parse({
      picks: [
        {
          story_ids: [7, 8, 9],
          lead_story_id: 8,
          rank: 2,
          reason: "an unfolding thread",
        },
      ],
      cuts_summary: "",
    });
    const n = normalizePick(out.picks[0]!);
    expect(n.is_arc).toBe(true);
    expect(n.story_ids).toEqual([7, 8, 9]);
    expect(n.lead_story_id).toBe(8);
  });

  test("rejects an arc with fewer than 2 stories", () => {
    expect(
      EditorOutputSchema.safeParse({
        picks: [{ story_ids: [7], lead_story_id: 7, rank: 1, reason: "x" }],
        cuts_summary: "",
      }).success,
    ).toBe(false);
  });
});

describe("EditorInputSchema", () => {
  test("defaults wikipedia_corroborated to false for pre-v0.4 replay rows", () => {
    const r = EditorInputSchema.parse({
      as_of_date: "2026-06-05",
      pool_composition: {
        total: 0,
        by_category: {},
        by_confidence: { low: 0, medium: 0, high: 0 },
        quiet_but_significant: [],
        loud_but_insignificant: [],
      },
      stories: [],
      themes: [
        {
          theme_id: 1,
          theme_name: "t",
          category: "politics",
          story_ids: [1, 2],
          first_published_at: null,
          last_published_at: null,
          day_span: 0,
          composite_max: 0,
          composite_sum: 0,
          tier1_sources_total: 0,
          age_days: 0,
          n_prior_publications: 0,
          trajectory: "new",
          is_long_running: false,
          // wikipedia_corroborated intentionally omitted
        },
      ],
    });
    expect(r.themes[0]!.wikipedia_corroborated).toBe(false);
  });
});
