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
});
export type ComposerInput = z.infer<typeof ComposerInputSchema>;

export const ComposerOutputSchema = z.object({
  markdown: z.string(),
  html: z.string(),
});
export type ComposerOutput = z.infer<typeof ComposerOutputSchema>;
