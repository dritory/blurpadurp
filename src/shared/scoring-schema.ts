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
  "politics",
  "science",
  "technology",
  "economy",
  "culture",
  "internet_culture",
  "environment_climate",
  "health",
  "society",
] as const;

// Drop out-of-vocab tags from LLM output rather than failing the whole
// scoring call. The prompt enumerates the allowed set; models occasionally
// invent new tags.
function filteredEnumArray<T extends readonly string[]>(allowed: T) {
  const set = new Set<string>(allowed);
  return z
    .array(z.string())
    .transform((arr) => arr.filter((s): s is T[number] => set.has(s)));
}

// Coerce null/undefined/missing string fields to "". Haiku sometimes
// nulls or omits reasoning free-text on early-rejects despite prompt
// instructions. nullish() accepts both null and undefined.
function nullableString() {
  return z
    .string()
    .nullish()
    .transform((s) => s ?? "");
}

// Coerce an unknown enum value to null rather than failing the whole call.
// Raw value is still preserved in ai_call_log.output_jsonb.
function filteredEnumOrNull<T extends readonly string[]>(allowed: T) {
  const set = new Set<string>(allowed);
  return z
    .string()
    .nullable()
    .transform((s) => (s !== null && set.has(s) ? (s as T[number]) : null));
}

export const ScorerOutputSchema = z.object({
  classification: z.object({
    category: filteredEnumOrNull(categorySlug),
    theme_continuation_of: z.string().nullable(),
    early_reject: z.boolean(),
    reject_reason: z.string().nullable(),
  }),

  reasoning: z.object({
    base_rate_per_year: z.number().nullish().transform((n) => n ?? 0),
    retrodiction_12mo: nullableString(),
    steelman_trivial: nullableString(),
    steelman_important: nullableString(),
    factors: z.object({
      trigger: filteredEnumArray(triggerFactors),
      penalty: filteredEnumArray(penaltyFactors),
      uncertainty: filteredEnumArray(uncertaintyFactors),
    }),
    theme_relationship: z.enum(themeRelationship),
    confidence: z.enum(["low", "medium", "high"]),
  }),

  scores: z.object({
    zeitgeist: z.number().int().min(0).max(5),
    half_life: z.number().int().min(0).max(5),
    reach: z.number().int().min(0).max(5),
    non_obviousness: z.number().int().min(0).max(5),
    structural_importance: z.number().int().min(0).max(5),
    composite: z.number(),
  }),

  summary: nullableString(),
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
