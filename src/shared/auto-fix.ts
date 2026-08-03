// The checker run/fix loop, shared by the /admin/review routes (manual,
// non-destructive: propose → preview → accept) and the auto-publish
// sweep (automatic: apply directly, up to N passes).
//
// These helpers previously lived inside src/api/admin.tsx. They moved
// here when the pipeline needed them too — a scheduled stage must not
// import the HTTP route module.
//
// The manual and automatic paths differ only in what they do with a
// recomposed brief. Manual stashes it on fix_candidate_jsonb for a human
// to accept; automatic writes it to the draft and records the prior
// version on auto_fix_jsonb. Both re-check the new prose before treating
// it as an improvement — a fix pass that introduces a *new* un-glossed
// term must not be mistaken for progress.

import { db } from "../db/index.ts";
import { runChecker, CHECKER_MODEL, CHECKER_VERSION } from "../ai/checker.ts";
import { lintGloss } from "./gloss-lint.ts";
import { loadGlossLists } from "./gloss-store.ts";
import { getConfigBool, getConfigNumber } from "./config-store.ts";
import { composeDraftFromInput } from "../pipeline/draft.ts";
import { markdownSha } from "./check-schema.ts";
import type {
  AutoFixLog,
  AutoFixPass,
  CheckFinding,
  CheckResult,
} from "./check-schema.ts";

const DEFAULT_MAX_PASSES = 2;

// Run the checker over arbitrary markdown (no DB). Returns the result or
// "failed" on error (already logged). Used both for the stored check and
// to re-check an unsaved fix candidate before it's applied.
export async function runCheckOnMarkdown(
  markdown: string,
): Promise<CheckResult | "failed"> {
  try {
    const lists = await loadGlossLists();
    const glossCandidates = lintGloss(markdown, lists.jargon, lists.ignored);
    const run = await runChecker({
      markdown,
      glossCandidates,
      ignoredTerms: lists.ignored,
    });
    return {
      checked_at: new Date().toISOString(),
      model_id: CHECKER_MODEL,
      prompt_version: CHECKER_VERSION,
      findings: run.findings,
      dismissed: run.dismissed,
      markdown_sha: markdownSha(markdown),
    };
  } catch (err) {
    console.error("[checker]", err);
    return "failed";
  }
}

// Run the checker over an issue's current brief and persist the result.
// Returns the stored CheckResult, null if the issue doesn't exist, or
// "failed" on error.
export async function runCheckAndStore(
  issueId: number,
): Promise<CheckResult | null | "failed"> {
  const iss = await db
    .selectFrom("issue")
    .select("composed_markdown")
    .where("id", "=", issueId)
    .executeTakeFirst();
  if (iss === undefined) return null;
  const result = await runCheckOnMarkdown(iss.composed_markdown);
  if (result === "failed") return "failed";
  await db
    .updateTable("issue")
    .set({ check_jsonb: JSON.stringify(result) as never })
    .where("id", "=", issueId)
    .execute();
  return result;
}

// Turn gloss findings into targeted composer revision notes for a
// fix-recompose. Non-gloss tasks are skipped (they have no recompose
// remedy yet).
//
// `attempt` (1-based) is appended as a note when it's not the first try.
// This is not decoration. The composer is cached on a hash of its
// rendered input (src/ai/composer.ts), so re-running a fix from the same
// findings returned the identical brief straight out of ai_call_log —
// the operator clicked "Re-generate fix", nothing changed, and the panel
// looked broken. Naming the attempt both breaks the hash and tells the
// composer something true and useful: the last try didn't land.
export function findingsToNotes(
  findings: CheckFinding[],
  attempt = 1,
): string[] {
  const notes = findings
    .filter((f) => f.task === "gloss")
    .map((f) => {
      const base = `"${f.term}" is used un-glossed on first use ("${f.excerpt}") — gloss it briefly on first use`;
      return f.suggestion ? `${base}, e.g. ${f.suggestion}.` : `${base}.`;
    });
  if (notes.length > 0 && attempt > 1) {
    notes.push(
      `This is revision attempt ${attempt}: attempt ${attempt - 1} left the terms above still un-glossed. Address each one explicitly this time, and do not introduce new un-glossed acronyms or specialist names while doing it.`,
    );
  }
  return notes;
}

export type AutoFixResult = AutoFixLog & { clean: boolean };

// Check a draft and, while it still has fixable gloss findings, recompose
// it from its own composer input with those findings as revision notes.
// Up to `compose.auto_fix_max_passes` rounds; each pass re-checks before
// the next decision.
//
// Applies fixes DIRECTLY to the draft (this is the no-gate path the
// operator asked for) but keeps the pre-fix prose in auto_fix_jsonb, so
// nothing becomes unreviewable — /admin/review renders the before/after.
//
// Only ever touches rows that are still drafts. Never throws: a checker
// or composer failure leaves the draft as-is and reports outcome
// "failed", which the caller treats as not-clean (so a broken draft
// holds rather than auto-publishing unchecked).
export async function autoFixDraft(issueId: number): Promise<AutoFixResult> {
  const enabled = await getConfigBool("compose.auto_fix_enabled", true);
  if (!enabled) {
    return {
      passes: [],
      final_findings: [],
      outcome: "disabled",
      // Auto-fix off must not imply auto-publish-blocked: the operator
      // turned the fixer off, they didn't ask us to park every draft.
      clean: true,
    };
  }

  const maxPasses = Math.floor(
    await getConfigNumber("compose.auto_fix_max_passes", DEFAULT_MAX_PASSES),
  );

  const iss = await db
    .selectFrom("issue")
    .select([
      "is_draft",
      "composed_markdown",
      "composer_input_jsonb",
      "auto_fix_jsonb",
    ])
    .where("id", "=", issueId)
    .executeTakeFirst();
  if (iss === undefined || !iss.is_draft) {
    return {
      passes: [],
      final_findings: [],
      outcome: "failed",
      clean: false,
    };
  }

  const passes: AutoFixPass[] = [];
  const initial = await runCheckOnMarkdown(iss.composed_markdown);
  if (initial === "failed") {
    return await persist(issueId, {
      passes,
      final_findings: [],
      outcome: "failed",
      attempts: (iss.auto_fix_jsonb as AutoFixLog | null)?.attempts ?? 0,
    }, false);
  }

  // BEST-SO-FAR, not last-accepted. A "fix" is a FULL recompose, so one
  // unlucky roll that trades two gaps for two others used to end the run
  // on the original prose — the shape of "the fixer ran and more terms
  // remain". Now: keep the lowest-finding-count prose, compose FROM it,
  // and spend the remaining passes. Adoption still requires a strict
  // improvement, so the draft can never get worse.
  // Attempts already spent on this draft by earlier sweeps. Numbering
  // continues from there so retry seven doesn't replay attempt one out
  // of the composer cache.
  const priorAttempts =
    (iss.auto_fix_jsonb as AutoFixLog | null)?.attempts ?? 0;

  type Composed = Awaited<ReturnType<typeof composeDraftFromInput>>;
  let bestOut: Composed | null = null; // null === the draft's own prose
  let bestCheck: CheckResult = initial;
  let bestMarkdown = iss.composed_markdown;
  // Set only when the loop stopped for a reason other than running out
  // of passes or finding nothing left to fix.
  let stopped: AutoFixLog["outcome"] | null = null;

  let attempts = priorAttempts;

  for (let pass = 1; pass <= maxPasses; pass++) {
    const findings = bestCheck.findings;
    if (findings.length === 0) break;

    // The attempt number goes into the notes deliberately: it breaks the
    // composer's input-hash cache (without it pass 2 replays pass 1
    // byte-for-byte out of ai_call_log) and it tells the model something
    // true -- the previous attempt did not land.
    const notes = findingsToNotes(findings, attempts + 1);
    if (notes.length === 0) {
      // Findings exist but none are gloss problems a recompose can
      // address. Stopping is correct -- looping would burn composer
      // calls without a remedy -- but the draft is NOT clean.
      stopped = "nothing_to_fix";
      break;
    }

    if (iss.composer_input_jsonb === null) {
      // No stored composer input -> nothing to recompose from.
      stopped = "failed";
      break;
    }

    attempts += 1;
    let recheck: CheckResult | "failed";
    let out: Composed;
    try {
      out = await composeDraftFromInput(iss.composer_input_jsonb, notes);
      recheck = await runCheckOnMarkdown(out.markdown);
    } catch (err) {
      console.error(`[auto-fix] issue ${issueId} pass ${pass}:`, err);
      stopped = "failed";
      break;
    }
    if (recheck === "failed") {
      stopped = "failed";
      break;
    }

    // Adopt only a strict improvement, so a thrashing composer can't
    // make the brief worse on its way to the deadline.
    const improved = recheck.findings.length < bestCheck.findings.length;
    passes.push({
      pass,
      at: new Date().toISOString(),
      notes,
      findings_before: bestCheck.findings,
      markdown_before: bestMarkdown,
      findings_after: recheck.findings,
      improved,
    });
    if (improved) {
      bestOut = out;
      bestCheck = recheck;
      bestMarkdown = out.markdown;
    }
  }

  // One write at the end, of the best prose seen — writing per-pass would
  // leave a version the loop had moved past if the process died mid-run.
  // The check result is stored even when nothing was adopted: the checker
  // DID run, and "checker hasn't run yet" over judged prose is how an
  // operator stops trusting the panel.
  await db
    .updateTable("issue")
    .set({
      ...(bestOut !== null
        ? {
            title: bestOut.title,
            composed_markdown: bestOut.markdown,
            composed_html: bestOut.html,
            composer_prompt_version: bestOut.promptVersion,
            composer_model_id: bestOut.modelId,
            // A freshly auto-fixed draft supersedes any manual proposal.
            fix_candidate_jsonb: null,
          }
        : {}),
      check_jsonb: JSON.stringify(bestCheck) as never,
    })
    .where("id", "=", issueId)
    .where("is_draft", "=", true)
    .execute();

  const finalFindings = bestCheck.findings;
  const clean = stopped === null && finalFindings.length === 0;
  return await persist(
    issueId,
    {
      passes,
      final_findings: finalFindings,
      outcome: stopped ?? (clean ? "clean" : "exhausted"),
      attempts,
    },
    clean,
  );
}

async function persist(
  issueId: number,
  log: AutoFixLog,
  clean: boolean,
): Promise<AutoFixResult> {
  await db
    .updateTable("issue")
    .set({ auto_fix_jsonb: JSON.stringify(log) as never })
    .where("id", "=", issueId)
    .execute();
  console.log(
    `[auto-fix] issue ${issueId}: outcome=${log.outcome} passes=${log.passes.length} remaining=${log.final_findings.length}`,
  );
  return { ...log, clean };
}
