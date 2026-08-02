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
import { loadGlossTerms } from "./gloss-store.ts";
import { getConfigBool, getConfigNumber } from "./config-store.ts";
import { composeDraftFromInput } from "../pipeline/draft.ts";
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
    const terms = await loadGlossTerms();
    const glossCandidates = lintGloss(markdown, terms);
    const findings = await runChecker({ markdown, glossCandidates });
    return {
      checked_at: new Date().toISOString(),
      model_id: CHECKER_MODEL,
      prompt_version: CHECKER_VERSION,
      findings,
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
export function findingsToNotes(findings: CheckFinding[]): string[] {
  return findings
    .filter((f) => f.task === "gloss")
    .map((f) => {
      const base = `"${f.term}" is used un-glossed on first use ("${f.excerpt}") — gloss it briefly on first use`;
      return f.suggestion ? `${base}, e.g. ${f.suggestion}.` : `${base}.`;
    });
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
    .select(["is_draft", "composed_markdown", "composer_input_jsonb"])
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
  let current = await runCheckOnMarkdown(iss.composed_markdown);
  if (current === "failed") {
    return await persist(issueId, {
      passes,
      final_findings: [],
      outcome: "failed",
    }, false);
  }

  let markdown = iss.composed_markdown;

  for (let pass = 1; pass <= maxPasses; pass++) {
    const findings = current.findings;
    if (findings.length === 0) break;

    const notes = findingsToNotes(findings);
    if (notes.length === 0) {
      // Findings exist but none are gloss problems a recompose can
      // address. Stopping is correct — looping would burn composer
      // calls without a remedy — but the draft is NOT clean.
      return await persist(issueId, {
        passes,
        final_findings: findings,
        outcome: "nothing_to_fix",
      }, false);
    }

    if (iss.composer_input_jsonb === null) {
      // No stored composer input → nothing to recompose from.
      return await persist(issueId, {
        passes,
        final_findings: findings,
        outcome: "failed",
      }, false);
    }

    let recheck: CheckResult | "failed";
    let out: Awaited<ReturnType<typeof composeDraftFromInput>>;
    try {
      out = await composeDraftFromInput(iss.composer_input_jsonb, notes);
      recheck = await runCheckOnMarkdown(out.markdown);
    } catch (err) {
      console.error(`[auto-fix] issue ${issueId} pass ${pass}:`, err);
      return await persist(issueId, {
        passes,
        final_findings: findings,
        outcome: "failed",
      }, false);
    }
    if (recheck === "failed") {
      return await persist(issueId, {
        passes,
        final_findings: findings,
        outcome: "failed",
      }, false);
    }

    // Guard against a recompose that trades one gap for another. We
    // accept a pass only if it strictly reduced the finding count;
    // otherwise keep the earlier prose and stop, so a thrashing
    // composer can't make the brief worse on its way to the deadline.
    const improved = recheck.findings.length < findings.length;
    passes.push({
      pass,
      at: new Date().toISOString(),
      notes,
      findings_before: findings,
      markdown_before: markdown,
      findings_after: recheck.findings,
      improved,
    });

    if (!improved) {
      return await persist(issueId, {
        passes,
        final_findings: findings,
        outcome: "exhausted",
      }, false);
    }

    await db
      .updateTable("issue")
      .set({
        title: out.title,
        composed_markdown: out.markdown,
        composed_html: out.html,
        composer_prompt_version: out.promptVersion,
        composer_model_id: out.modelId,
        check_jsonb: JSON.stringify(recheck) as never,
        // A freshly auto-fixed draft supersedes any manual proposal.
        fix_candidate_jsonb: null,
      })
      .where("id", "=", issueId)
      .where("is_draft", "=", true)
      .execute();

    markdown = out.markdown;
    current = recheck;
  }

  const finalFindings = current.findings;
  return await persist(issueId, {
    passes,
    final_findings: finalFindings,
    outcome: finalFindings.length === 0 ? "clean" : "exhausted",
  }, finalFindings.length === 0);
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
