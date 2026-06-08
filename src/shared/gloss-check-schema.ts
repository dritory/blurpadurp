// I/O for the on-demand LLM gloss-checker (src/ai/gloss-checker.ts).
//
// The deterministic linter (gloss-lint.ts) is the zero-cost recall floor;
// this is the ceiling-raiser the operator triggers from /admin/review. It
// catches the long tail the regex can't — specialist NAMES with no entry
// in the jargon list ("Brent", a novel drug) — and judges whether a gloss
// is actually adequate for a non-specialist, not just punctuation-present.
// The deterministic findings are fed in as grounding candidates so the
// model verifies a concrete list instead of free-associating.

import { z } from "zod";

export const GlossCheckFindingSchema = z.object({
  // The acronym/name as it appears in the brief.
  term: z.string(),
  // acronym = all-caps initialism; jargon = a specialist word/name.
  kind: z.enum(["acronym", "jargon"]).default("jargon"),
  // The first-use sentence/clause, quoted from the brief.
  first_use: z.string(),
  // missing = no gloss at all; weak = present but too thin for a
  // literate non-specialist.
  severity: z.enum(["missing", "weak"]),
  // A short proposed gloss (≤6 words), or "" if none offered.
  suggestion: z.string().default(""),
});

export const GlossCheckOutputSchema = z.object({
  findings: z.array(GlossCheckFindingSchema),
});

export type GlossCheckFinding = z.infer<typeof GlossCheckFindingSchema>;
export type GlossCheckOutput = z.infer<typeof GlossCheckOutputSchema>;

// What gets persisted on issue.gloss_check_jsonb and rendered on the
// review panel: the findings plus provenance (which model/prompt/when).
export interface GlossCheckResult {
  checked_at: string; // ISO 8601
  model_id: string;
  prompt_version: string;
  findings: GlossCheckFinding[];
}
