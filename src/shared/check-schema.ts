// I/O for the on-demand "checker" (src/ai/checker.ts) — a draft-review
// aid that runs one or more focused review TASKS over a composed brief.
// Today there's one task, "gloss" (un-glossed acronyms/specialist names
// on first use); the shape is deliberately task-tagged so adding a second
// task later (source-fidelity, banned voice-failures, dead links…) is a
// localized change: a new task module emits CheckFinding rows with its
// own `task` id, and the storage + review panel already group by task.
//
// Each task can still validate its own LLM tool output against a precise
// task-specific schema inside checker.ts; CheckFinding is the generic
// shape everything is mapped into for storage + display.

import { z } from "zod";

// Known task ids. Extend this when a new task module lands.
export const CHECK_TASKS = ["gloss"] as const;
export type CheckTask = (typeof CHECK_TASKS)[number];

export const CheckFindingSchema = z.object({
  // Which task produced this finding.
  task: z.string().default("gloss"),
  // The flagged locus — for gloss, the term/name.
  term: z.string(),
  // Task-specific subtype — for gloss, "acronym" | "jargon".
  kind: z.string().default(""),
  // The relevant quote from the brief (gloss: the first-use sentence).
  excerpt: z.string(),
  // Task-specific severity — for gloss, "missing" | "weak".
  severity: z.string().default(""),
  // A proposed fix (gloss: a ≤6-word suggested gloss), or "".
  suggestion: z.string().default(""),
});
export type CheckFinding = z.infer<typeof CheckFindingSchema>;

export const CheckOutputSchema = z.object({
  findings: z.array(CheckFindingSchema),
});
export type CheckOutput = z.infer<typeof CheckOutputSchema>;

// Persisted on issue.check_jsonb and rendered on the review panel: the
// findings (across all tasks run) plus provenance.
export interface CheckResult {
  checked_at: string; // ISO 8601
  model_id: string;
  prompt_version: string;
  findings: CheckFinding[];
}
