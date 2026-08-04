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

import { createHash } from "node:crypto";
import { z } from "zod";

// Identity of a piece of composed prose, used to tell a stored check
// result that is still about the current draft from one that isn't.
export function markdownSha(markdown: string): string {
  return createHash("sha256").update(markdown).digest("hex");
}

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

// A pre-screen candidate the LLM layer looked at and decided NOT to
// flag. Kept alongside the findings so the review page can render the
// deterministic linter's warnings as *settled* instead of leaving two
// layers visibly contradicting each other — the "why is it still
// shouting about BBC?" case.
export const CheckDismissalSchema = z.object({
  task: z.string().default("gloss"),
  term: z.string(),
  reason: z.string().default(""),
});
export type CheckDismissal = z.infer<typeof CheckDismissalSchema>;

export const CheckOutputSchema = z.object({
  findings: z.array(CheckFindingSchema),
  dismissed: z.array(CheckDismissalSchema).default([]),
});
export type CheckOutput = z.infer<typeof CheckOutputSchema>;

// Persisted on issue.check_jsonb and rendered on the review panel: the
// findings (across all tasks run) plus provenance.
export interface CheckResult {
  checked_at: string; // ISO 8601
  model_id: string;
  prompt_version: string;
  findings: CheckFinding[];
  // Pre-screen candidates the checker overruled. Optional: rows written
  // before mig 070 don't have it.
  dismissed?: CheckDismissal[];
  // SHA-256 of the markdown this result was computed from. Without it a
  // stored result is indistinguishable from a current one, so the panel
  // showed a clean bill of health for prose that had since been
  // recomposed — and the fix path fed the composer stale findings.
  // Optional for the same pre-mig-070 reason; absent means "unknown,
  // treat as stale".
  markdown_sha?: string;
}

// Is this stored check still about the prose in front of us?
// An unstamped (pre-mig-070) result is treated as stale: a check whose
// subject we can't establish has to be re-run, not trusted.
export function isCheckCurrent(
  result: CheckResult | null,
  markdownSha: string,
): boolean {
  if (result === null) return false;
  return (
    typeof result.markdown_sha === "string" &&
    result.markdown_sha === markdownSha
  );
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
  // Findings still present after this pass recomposed the brief.
  findings_after: CheckFinding[];
  // False when the recompose didn't reduce the finding count — the pass
  // ran but bought nothing.
  improved: boolean;
  // Identity, not content: which prose this pass started from. The full
  // markdown used to live here, which put up to two extra copies of the
  // brief in a jsonb column rewritten on every sweep — see mig 073.
  markdown_before_sha?: string;
}

export interface AutoFixLog {
  passes: AutoFixPass[];
  // Findings outstanding when the loop stopped. Empty === clean.
  final_findings: CheckFinding[];
  // Why the loop stopped, for the review page and the hold notification.
  outcome: "clean" | "exhausted" | "nothing_to_fix" | "failed" | "disabled";
  // Cumulative recompose attempts across every sweep that has touched
  // this draft, not just the last one. Two jobs: it caps total spend
  // (compose.auto_fix_max_attempts) and it keeps seeding the attempt
  // number that busts the composer's input-hash cache, so retry number
  // seven is still a genuinely new roll. Absent on pre-mig-071 rows.
  attempts?: number;
  // Times autoFixDraft has been invoked on this draft. Distinct from
  // attempts (recompose calls) and load-bearing for a different reason:
  // it is the bound that no per-path accounting bug can defeat. Two
  // early-exit paths in mig 071 returned without incrementing attempts
  // and shouldRetryAutoFix reads outcome="failed" as retryable, so those
  // drafts re-ran hourly forever. Counting invocations makes the loop
  // terminate regardless of what any individual path forgets to do.
  runs?: number;
  // The audit trail — as of mig 072 the only one, since the fix applies
  // without a human approving it. Findings only: the composer's original
  // PROSE lived here too until mig 073, which is what filled the storage
  // budget. Prose belongs in ai_call_log, which is keyed by input_hash,
  // persisted forever by design, and has a cold-storage path to R2;
  // `bun run cli composer-replay <issue>` renders it. The sha is kept so
  // the panel can still say whether the brief actually changed.
  original_findings?: CheckFinding[];
  original_markdown_sha?: string;
}

// Should the sweep spend another auto-fix run on this draft?
// Retrying is what makes the loop converge without a human: a fix is a
// full recompose, so any single run is partly luck, and doing nothing
// for the 23 hours between the first run and the deadline was the
// difference between "the fixer ran" and "the fixer worked".
export function shouldRetryAutoFix(
  raw: unknown,
  maxAttempts: number,
): boolean {
  const log = raw as AutoFixLog | null;
  if (log === null || typeof log !== "object") return true; // never run
  if (log.outcome === "disabled") return false;
  // No remedy and no reason to think another roll finds one.
  if (log.outcome === "nothing_to_fix") return false;
  if (isCleanAutoFix(log)) return false;
  // TWO independent bounds, deliberately. Attempts counts recompose
  // calls, which is the thing worth rationing — but a path that exits
  // before spending one leaves it unincremented, and an unincremented
  // counter compared against a cap is an infinite loop. Runs counts
  // invocations, so the loop terminates even when a path forgets.
  if ((log.runs ?? 0) >= maxAttempts) return false;
  return (log.attempts ?? log.passes?.length ?? 0) < maxAttempts;
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
