// Editor stage I/O. Mirrors docs/editor-prompt.md.

import { z } from "zod";

import { categorySlug, themeRelationship } from "./scoring-schema.ts";

export const EditorInputSchema = z.object({
  as_of_date: z.string(),
  stories: z.array(
    z.object({
      story_id: z.number(),
      title: z.string(),
      category: z.enum(categorySlug).nullable(),
      theme_name: z.string().nullable(),
      composite: z.number(),
      zeitgeist: z.number(),
      half_life: z.number(),
      reach: z.number(),
      non_obviousness: z.number(),
      confidence: z.enum(["low", "medium", "high"]).nullable(),
      tier1_sources: z.number(),
      total_sources: z.number(),
      theme_relationship: z.enum(themeRelationship).nullable(),
      scorer_one_liner: z.string(),
      retrodiction_12mo: z.string(),
      factors_trigger: z.array(z.string()),
      factors_penalty: z.array(z.string()),
    }),
  ),
});
export type EditorInput = z.infer<typeof EditorInputSchema>;

export const EditorOutputSchema = z.object({
  picks: z.array(
    z.object({
      story_id: z.number(),
      rank: z.number(),
      reason: z.string(),
    }),
  ),
  cuts_summary: z.string(),
});
export type EditorOutput = z.infer<typeof EditorOutputSchema>;
