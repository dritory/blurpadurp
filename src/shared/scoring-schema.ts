// Zod schema mirroring docs/scoring-prompt.md output contract.
// Pre-1.0: free to evolve. When it changes, bump scorer_version in
// docs/scoring-prompt.md and store old rows as-is (raw_output preserves them).

import { z } from "zod";

export const triggerFactors = [
  "systemic_risk",
  "regulatory_change",
  "technical_breakthrough",
  "novel_finding",
  "geopolitical_realignment",
  "cultural_absorption",
  "crossover_discussion",
  "market_structure_change",
  "precedent_setting",
  "scale_of_impact",
  "first_of_kind",
] as const;

export const penaltyFactors = [
  "high_base_rate",
  "hindsight_required",
  "reversible",
  "single_platform",
  "unreplicated",
  "preclinical_only",
  "speculative_forecast",
  "in_circle_hype",
  "manufactured_hype",
  "controversy_flash",
  "symbolic_only",
  "narrow_audience",
] as const;

export const uncertaintyFactors = [
  "novel_event_type",
  "insufficient_evidence",
  "contested_interpretation",
  "long_causal_chain",
  "no_precedent",
  "counterfactual_required",
] as const;

export const themeRelationship = [
  "new_theme",
  "continuation_routine",
  "continuation_escalation",
  "continuation_reversal",
  "continuation_resolution",
] as const;

export const categorySlug = [
  "geopolitics",
  "policy",
  "science",
  "technology",
  "economy",
  "culture",
  "internet_culture",
  "environment_climate",
  "health",
  "society",
] as const;

export const ScorerOutputSchema = z.object({
  schema_version: z.string(),
  scorer_version: z.string(),
  scored_at: z.string(),
  as_of_date: z.string(),

  classification: z.object({
    category: z.enum(categorySlug),
    theme_continuation_of: z.string().nullable(),
    early_reject: z.boolean(),
    early_reject_reason: z.string().nullable(),
  }),

  reasoning: z.object({
    base_rate_estimate: z.string(),
    base_rate_per_year: z.number(),
    retrodiction_12mo: z.string(),
    steelman_trivial: z.string(),
    steelman_important: z.string(),
    factors: z.object({
      trigger: z.array(z.enum(triggerFactors)),
      penalty: z.array(z.enum(penaltyFactors)),
      uncertainty: z.array(z.enum(uncertaintyFactors)),
    }),
    theme_relationship: z.enum(themeRelationship),
    point_in_time_confidence: z.enum(["low", "medium", "high"]),
  }),

  scores: z.object({
    zeitgeist_score: z.number().int().min(0).max(5),
    half_life: z.number().int().min(0).max(5),
    reach: z.number().int().min(0).max(5),
    non_obviousness: z.number().int().min(0).max(5),
    structural_importance: z.number().int().min(0).max(5),
    composite: z.number(),
  }),

  verification: z.unknown().nullable(),
  tools_used: z.unknown().nullable(),
  watchlist_signal: z.unknown().nullable(),
  viral_signals_considered: z.unknown().nullable(),

  one_line_summary: z.string().max(140),
});

export type ScorerOutput = z.infer<typeof ScorerOutputSchema>;

export const ScorerInputSchema = z.object({
  as_of_date: z.string(),
  story: z.object({
    title: z.string(),
    summary: z.string().optional(),
    source_url: z.string().optional(),
    published_at: z.string().optional(),
  }),
  gdelt_metadata: z
    .object({
      event_id: z.string().optional(),
      wikipedia_corroborated: z.boolean().optional(),
      source_count: z.number().optional(),
      mention_count_48h: z.number().optional(),
      tone_mean: z.number().optional(),
    })
    .optional(),
  theme_context: z
    .object({
      theme_name: z.string(),
      theme_description: z.string().optional(),
      rolling_composite_avg: z.number().optional(),
      recent_stories: z.array(
        z.object({
          date: z.string(),
          zeitgeist: z.number().optional(),
          one_line_summary: z.string(),
        }),
      ),
    })
    .nullable(),
  viral_signals: z
    .object({
      google_trends_7d_ratio: z.number().optional(),
      google_trends_14d_tail: z.number().optional(),
      cross_platform_count: z.number().optional(),
      mainstream_crossover: z.boolean().optional(),
      derivative_works_count: z.number().optional(),
      kym_status: z.string().nullable().optional(),
    })
    .optional(),
});

export type ScorerInput = z.infer<typeof ScorerInputSchema>;
