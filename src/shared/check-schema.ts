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

// A pending, non-destructive fix proposal for a draft (issue
// .fix_candidate_jsonb). The checker's Re-compose-to-fix path composes
// new prose from the findings but does NOT overwrite the draft — it
// stashes the result here for the reviewer to preview and Accept/Discard.
export interface FixCandidate {
  created_at: string; // ISO 8601
  // The revision notes (derived from findings) fed to the composer.
  notes: string[];
  title: string;
  composed_markdown: string;
  composed_html: string;
  prompt_version: string;
  model_id: string;
  // Re-check of the candidate prose, so the panel can show what the
  // proposal would (or wouldn't) resolve before it's applied.
  check: CheckResult;
}

// ============================================================
// Automatic fix loop (mig 066). Types + the cleanliness predicate live
// here, in the dependency-free schema module, so the pipeline sweep and
// the review page share one definition instead of two that must agree.
// ============================================================

// One recorded automatic pass, persisted on issue.auto_fix_jsonb so the
// review page can show what the machine changed and why.
export interface AutoFixPass {
  pass: number;
  at: string; // ISO 8601
  notes: string[];
  findings_before: CheckFinding[];
  markdown_before: string;
  // Findings still present after this pass recomposed the brief.
  findings_after: CheckFinding[];
  // False when the recompose didn't reduce the finding count — the pass
  // ran but bought nothing.
  improved: boolean;
}

export interface AutoFixLog {
  passes: AutoFixPass[];
  // Findings outstanding when the loop stopped. Empty === clean.
  final_findings: CheckFinding[];
  // Why the loop stopped, for the review page and the hold notification.
  outcome: "clean" | "exhausted" | "nothing_to_fix" | "failed" | "disabled";
}

// Is this draft safe to publish unattended?
//
// The last gate before an issue is mailed, and email is irreversible
// (dispatch_log is at-most-once, there is no recall). Every ambiguous
// input therefore resolves to NOT clean: a draft that merely fails to
// prove itself safe gets held, not sent.
export function isCleanAutoFix(raw: unknown): boolean {
  const log = raw as { outcome?: string; final_findings?: unknown[] } | null;
  if (log === null || typeof log !== "object") return false;
  // Explicit operator kill-switch: the fixer is off, which is not a
  // statement about this draft. Publish on the normal schedule.
  if (log.outcome === "disabled") return true;
  if (log.outcome !== "clean") return false;
  // Require a real array. A missing findings list is a malformed record,
  // not a clean bill of health — treating absent evidence as proof of
  // cleanliness would mail an unverified brief.
  return Array.isArray(log.final_findings) && log.final_findings.length === 0;
}
