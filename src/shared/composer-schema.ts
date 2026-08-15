// Zod schemas for the composer stage I/O. Mirrors docs/composer-prompt.md.
//
// The composer is deliberately not given section-assignment work:
// compose.ts pre-sorts every item into one of four section arrays
// (conversation / worth_knowing / worth_watching / shrug). The composer
// writes prose for what it's given and never decides placement.

import { z } from "zod";
import { categorySlug, themeRelationship } from "./scoring-schema.ts";

// A single story as the composer sees it inside an item.
const ItemStorySchema = z.object({
  story_id: z.number(),
  title: z.string(),
  summary: z.string().nullable(),
  source_url: z.string().nullable(),
  additional_source_urls: z.array(z.string()),
  category: z.enum(categorySlug).nullable(),
  theme_name: z.string().nullable(),
  theme_relationship: z.enum(themeRelationship).nullable(),
  zeitgeist_score: z.number(),
  half_life: z.number(),
  reach: z.number(),
  composite: z.number(),
  scorer_one_liner: z.string(),
  retrodiction_12mo: z.string(),
  published_at: z.string().nullable(),
  // Catch-up story: older than the brief's own week, pulled in by a
  // catch-up run because it would otherwise never be published.
  //
  // The composer MUST date these explicitly instead of using the
  // issue's default "this week" framing — the prose is written for a
  // weekly, so an undated three-week-old item reads as fresh news and
  // misleads the reader. See composer-prompt.md "Catch-up items".
  catch_up: z.boolean().default(false),
  // Whole days between published_at and the compose run, so the
  // composer can pick the right time marker ("three weeks ago",
  // "in late July") rather than guessing from the date alone.
  age_days: z.number().default(0),
});

// An item is one paragraph the composer writes: single story or arc
// (2-5 stories on the same theme, rendered chronologically as one
// paragraph). lead_story_id anchors the headline.
export const ComposerItemSchema = z.object({
  kind: z.enum(["single", "arc"]),
  rank: z.number(),
  lead_story_id: z.number(),
  stories: z.array(ItemStorySchema).min(1),
  reason: z.string(), // editor's ≤25 word justification
});
export type ComposerItem = z.infer<typeof ComposerItemSchema>;

// Shrug entries are distinct from items — no arc concept, no theme
// grouping, just a one-line dismissal per row.
export const ShrugItemSchema = z.object({
  story_id: z.number(),
  title: z.string(),
  source_url: z.string().nullable(),
  category: z.enum(categorySlug).nullable(),
  // The reader-facing tag, chosen server-side (compose-shrug.ts) so the
  // section can't ship five identical labels. Optional because stored
  // composer inputs from before v0.12 don't carry it — fixture replay
  // parses those rows, and the renderer falls back to penalty_factors.
  label: z.string().optional(),
  penalty_factors: z.array(z.string()),
  source_count: z.number(),
  scorer_one_liner: z.string(),
});
export type ShrugItem = z.infer<typeof ShrugItemSchema>;

export const ComposerInputSchema = z.object({
  week_of: z.string(),
  // Four pre-sorted section arrays. The composer renders each section
  // with the register described in the prompt and NEVER moves items
  // between sections. Any array may be empty; empty sections are omitted
  // from output.
  conversation: z.array(ComposerItemSchema),
  worth_knowing: z.array(ComposerItemSchema),
  worth_watching: z.array(ComposerItemSchema),
  shrug: z.array(ShrugItemSchema),
  // Synthesis input: the themes the composer should touch in the
  // opening paragraph (if at least 2). Pre-computed server-side from
  // the items above. Empty array = skip the opener entirely.
  synthesis_themes: z.array(
    z.object({
      theme_name: z.string(),
      category: z.enum(categorySlug).nullable(),
      shape: z.string(), // e.g. "Hormuz widening", "ceasefire talks resumed"
      is_arc: z.boolean(),
      trajectory: z.enum(["new", "rising", "stable", "falling"]),
    }),
  ),
  // Theme timelines: for every theme that appears in any section above,
  // the full recent history of stories under that theme — both already-
  // published (prior issues) and in-current-issue entries. Lets the
  // composer anchor arcs to the longer arc ("three weeks in", "since
  // last month's X") instead of treating each week as a clean slate.
  theme_timelines: z.array(
    z.object({
      theme_id: z.number(),
      theme_name: z.string(),
      category: z.enum(categorySlug).nullable(),
      trajectory: z.enum(["new", "rising", "stable", "falling"]),
      is_long_running: z.boolean(),
      n_prior_publications: z.number(),
      entries: z.array(
        z.object({
          date: z.string(), // YYYY-MM-DD
          one_liner: z.string(),
          in_current_issue: z.boolean(),
        }),
      ),
    }),
  ),
  // What the last few issues actually ran, newest first. theme_timelines
  // already gives per-theme story history, but not the issue-level view:
  // which stories the reader has already had explained to them, and how
  // the last brief framed its week. Without it the composer re-introduces
  // a three-week-old thread as though it were new, and reaches for the
  // same opener shape every time. Defaulted so composer_input_jsonb
  // persisted before v0.11 still re-parses for replay.
  recent_issues: z
    .array(
      z.object({
        published_at: z.string(), // YYYY-MM-DD
        title: z.string().nullable(),
        weeks_ago: z.number(),
        // Themes that issue led with, in rank order — what the reader
        // most recently had a full paragraph about.
        led_with: z.array(z.string()),
        // One-liners already told, across every section of that issue.
        already_told: z.array(z.string()),
      }),
    )
    .default([]),
  // Targeted revision notes fed back into a re-compose — e.g. the gloss
  // checker's findings ("VRA used un-glossed on first use; gloss it").
  // Absent on a first compose; set only when re-composing to fix specific
  // problems. The composer applies them and leaves everything else as-is.
  // Not persisted on the issue's composer_input_jsonb (it's a transient
  // correction for one re-compose, not part of the canonical input).
  revision_notes: z.array(z.string()).optional(),
});
export type ComposerInput = z.infer<typeof ComposerInputSchema>;

export const ComposerOutputSchema = z.object({
  title: z.string().min(1).max(120),
  markdown: z.string(),
  html: z.string(),
});
export type ComposerOutput = z.infer<typeof ComposerOutputSchema>;
