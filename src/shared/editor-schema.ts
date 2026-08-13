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
      // Catch-up pick (editor v0.5): older than the normal freshness
      // window, selected on structural_importance × half_life rather
      // than the gate — so unlike every other pool member it may have
      // passed_gate = false. Its zeitgeist score is a stale
      // point-in-time reading and should not drive the decision.
      catch_up: z.boolean().default(false),
      // Whole days since published_at (or ingested_at when undated).
      age_days: z.number().default(0),
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
      // True if any story attached to this theme came from the Wikipedia
      // connector (ITN box or Current Events portal). Wikipedia entries
      // never enter the editor pool themselves — they're a curation
      // signal: editors at en.wikipedia.org thought the underlying event
      // was significant enough to surface. Treat as a meaningful "this
      // matters" prior, especially for quiet-but-significant picks.
      // Default false so editor_input_jsonb persisted before v0.4
      // (without the field) still re-parses for replay.
      wikipedia_corroborated: z.boolean().default(false),
      // Narrative cluster (editor v0.6). Themes sharing a key are arcs
      // of one running story — the reader experiences "US–Iran
      // escalation" and "Hormuz shipping" as the same news. Null when
      // the theme has no centroid to measure. Defaulted so pre-v0.6
      // editor_input_jsonb still re-parses for replay.
      cluster_key: z.string().nullable().default(null),
      // How many of the last few published issues already carried this
      // theme, and what the most recent one said about it. The editor
      // used to see only n_prior_publications — a count with no content,
      // which cannot answer "have we already said this?".
      recent_issue_count: z.number().default(0),
      last_covered_date: z.string().nullable().default(null),
      last_covered_summary: z.string().nullable().default(null),
    }),
  ),
  // Multi-theme narrative clusters in this pool. Only clusters that
  // actually group two or more themes appear; a cluster of one is just
  // a theme and would be noise here.
  narrative_clusters: z
    .array(
      z.object({
        cluster_key: z.string(),
        theme_ids: z.array(z.number()),
        theme_names: z.array(z.string()),
        n_stories: z.number(),
      }),
    )
    .default([]),
  // What the last few issues actually covered. Prior-issue memory was
  // the "next likely signal" in the v0.5 notes: without it the editor
  // re-picks the same running story week after week with no way to know
  // it is repeating itself.
  recent_coverage: z
    .array(
      z.object({
        issue_id: z.number(),
        published_at: z.string(), // YYYY-MM-DD
        title: z.string().nullable(),
        weeks_ago: z.number(),
        items: z.array(
          z.object({
            theme_id: z.number().nullable(),
            theme_name: z.string().nullable(),
            section: z.string(),
            summary: z.string(),
          }),
        ),
      }),
    )
    .default([]),
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
