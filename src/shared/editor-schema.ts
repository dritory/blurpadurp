// Editor stage I/O. Mirrors docs/editor-prompt.md.

import { z } from "zod";

import { categorySlug, themeRelationship } from "./scoring-schema.ts";

export const EditorInputSchema = z.object({
  as_of_date: z.string(),
  // Pre-computed pool shape — category/confidence distribution plus
  // explicit lists of the "interesting" cohorts: quiet-but-significant
  // items (the Worth-knowing population) and loud-but-insignificant
  // items (the zeitgeist stenography trap). Lets the editor see the
  // composition it's working with rather than inferring it story-by-story.
  pool_composition: z.object({
    total: z.number(),
    by_category: z.record(z.string(), z.number()),
    by_confidence: z.object({
      low: z.number(),
      medium: z.number(),
      high: z.number(),
    }),
    quiet_but_significant: z.array(z.number()), // story_ids with low zeitgeist, high structural
    loud_but_insignificant: z.array(z.number()), // story_ids with high zeitgeist, low structural
  }),
  stories: z.array(
    z.object({
      story_id: z.number(),
      title: z.string(),
      category: z.enum(categorySlug).nullable(),
      theme_id: z.number().nullable(),
      theme_name: z.string().nullable(),
      published_at: z.string().nullable(), // ISO 8601; enables arc chronology
      composite: z.number(),
      zeitgeist: z.number(),
      half_life: z.number(),
      reach: z.number(),
      non_obviousness: z.number(),
      // The second axis: 0-5, "will this matter in 12 months?" —
      // independent of zeitgeist. High-structural/low-zeitgeist items
      // are the quiet-but-consequential picks the reader would miss
      // otherwise. Surfaced to the editor starting in v0.3.
      structural_importance: z.number(),
      // Scorer's "how often does this kind of event happen per year" —
      // calibrated significance prior. Low base_rate (< 0.5) means
      // rare/precedent-setting; high base_rate (> 10) means routine.
      base_rate_per_year: z.number(),
      confidence: z.enum(["low", "medium", "high"]).nullable(),
      tier1_sources: z.number(),
      total_sources: z.number(),
      theme_relationship: z.enum(themeRelationship).nullable(),
      scorer_one_liner: z.string(),
      // The scorer's strongest case FOR including this story — already
      // generated during scoring, now surfaced to the editor so it
      // doesn't have to reconstruct significance from the one-liner.
      steelman_important: z.string(),
      retrodiction_12mo: z.string(),
      factors_trigger: z.array(z.string()),
      factors_penalty: z.array(z.string()),
    }),
  ),
  // Pre-computed theme digest. Every theme with at least one story in
  // the pool gets one entry here with its chronological story_id list
  // and aggregate signals. Makes arc candidates structurally visible:
  // any theme with story_ids.length >= 2 AND day_span >= 2 is a
  // natural arc pick. Trajectory + prior_issue_count add cross-issue
  // context so the editor can weight a continuing theme over a fresh
  // one.
  themes: z.array(
    z.object({
      theme_id: z.number(),
      theme_name: z.string(),
      category: z.enum(categorySlug).nullable(),
      story_ids: z.array(z.number()), // chronological (earliest first)
      first_published_at: z.string().nullable(),
      last_published_at: z.string().nullable(),
      day_span: z.number(), // whole days between first and last, 0 if same-day
      composite_max: z.number(),
      composite_sum: z.number(),
      tier1_sources_total: z.number(),
      // Cross-issue context
      age_days: z.number(), // days since first_seen_at on the theme row
      n_prior_publications: z.number(), // issues that have included this theme before
      trajectory: z.enum(["new", "rising", "stable", "falling"]),
      is_long_running: z.boolean(),
    }),
  ),
});
export type EditorInput = z.infer<typeof EditorInputSchema>;

export const EditorOutputSchema = z.object({
  picks: z.array(
    z.union([
      // Single-story pick (backward compatible with editor-v0.1).
      z.object({
        story_id: z.number(),
        rank: z.number(),
        reason: z.string(),
      }),
      // Arc pick: a set of stories on the same theme, written by the
      // composer as one chronological item. lead_story_id is the anchor
      // (the scorer summary used for the headline).
      z.object({
        story_ids: z.array(z.number()).min(2),
        lead_story_id: z.number(),
        rank: z.number(),
        reason: z.string(),
      }),
    ]),
  ),
  cuts_summary: z.string(),
});
export type EditorOutput = z.infer<typeof EditorOutputSchema>;

// Normalized pick: always carries a populated story_ids array, with
// is_arc flagged for composer branching. Singles expand to length-1 arrays.
export interface NormalizedPick {
  lead_story_id: number;
  story_ids: number[];
  rank: number;
  reason: string;
  is_arc: boolean;
}

export function normalizePick(
  p: EditorOutput["picks"][number],
): NormalizedPick {
  if ("story_ids" in p) {
    return {
      lead_story_id: p.lead_story_id,
      story_ids: p.story_ids,
      rank: p.rank,
      reason: p.reason,
      is_arc: true,
    };
  }
  return {
    lead_story_id: p.story_id,
    story_ids: [p.story_id],
    rank: p.rank,
    reason: p.reason,
    is_arc: false,
  };
}
