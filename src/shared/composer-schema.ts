// Zod schemas for the composer stage I/O. Mirrors docs/composer-prompt.md.

import { z } from "zod";
import { categorySlug, themeRelationship } from "./scoring-schema.ts";

// A single story as the composer sees it inside an item. Mirrors the
// flat `stories` entry shape.
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

// An item is one unit the composer writes — either a single story or an
// arc (2+ stories on the same theme written chronologically as one
// paragraph). `lead_story_id` anchors the headline framing; `rank` is
// inherited from the editor's pick order.
export const ComposerItemSchema = z.object({
  kind: z.enum(["single", "arc"]),
  rank: z.number(),
  lead_story_id: z.number(),
  stories: z.array(ItemStorySchema).min(1),
  reason: z.string(), // editor's ≤20/≤25 word justification
});
export type ComposerItem = z.infer<typeof ComposerItemSchema>;

export const ShrugCandidateSchema = z.object({
  story_id: z.number(),
  title: z.string(),
  source_url: z.string().nullable(),
  category: z.enum(categorySlug).nullable(),
  penalty_factors: z.array(z.string()),
  source_count: z.number(),
  scorer_one_liner: z.string(),
});
export type ShrugCandidate = z.infer<typeof ShrugCandidateSchema>;

export const ComposerInputSchema = z.object({
  week_of: z.string(),
  stories: z.array(
    z.object({
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
    }),
  ),
  items: z.array(ComposerItemSchema),
  watch_candidate_ids: z.array(z.number()),
  shrug_candidates: z.array(ShrugCandidateSchema),
  prior_theme_context: z.array(
    z.object({
      theme_name: z.string(),
      last_published: z.string(),
      last_one_liner: z.string(),
    }),
  ),
});
export type ComposerInput = z.infer<typeof ComposerInputSchema>;

export const ComposerOutputSchema = z.object({
  markdown: z.string(),
  html: z.string(),
});
export type ComposerOutput = z.infer<typeof ComposerOutputSchema>;
