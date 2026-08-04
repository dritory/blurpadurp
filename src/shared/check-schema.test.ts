import { describe, expect, test } from "bun:test";
import type { AutoFixLog } from "./check-schema.ts";
import {
  isCheckCurrent,
  isCleanAutoFix,
  markdownSha,
  shouldRetryAutoFix,
  type CheckResult,
} from "./check-schema.ts";
import { findingsToNotes } from "./auto-fix.ts";

function result(over: Partial<CheckResult> = {}): CheckResult {
  return {
    checked_at: "2026-08-01T00:00:00.000Z",
    model_id: "claude-haiku-4-5-20251001",
    prompt_version: "checker-v2",
    findings: [],
    ...over,
  };
}

describe("isCheckCurrent", () => {
  const md = "# Brief\n\nThe IRGC mobilised.\n";

  test("a stamped result matching the prose is current", () => {
    expect(
      isCheckCurrent(result({ markdown_sha: markdownSha(md) }), markdownSha(md)),
    ).toBe(true);
  });

  test("a result stamped with different prose is stale", () => {
    expect(
      isCheckCurrent(
        result({ markdown_sha: markdownSha("something else") }),
        markdownSha(md),
      ),
    ).toBe(false);
  });

  test("an unstamped (pre-mig-070) result is treated as stale", () => {
    // The whole point: a verdict whose subject we can't establish must
    // be re-run, not trusted. It's the case that let a months-old
    // "clean" render over freshly-recomposed prose.
    expect(isCheckCurrent(result(), markdownSha(md))).toBe(false);
  });

  test("no result at all is not current", () => {
    expect(isCheckCurrent(null, markdownSha(md))).toBe(false);
  });
});

describe("isCleanAutoFix", () => {
  test("clean with no outstanding findings is clean", () => {
    expect(isCleanAutoFix({ outcome: "clean", final_findings: [] })).toBe(true);
  });

  test("exhausted is never clean", () => {
    expect(isCleanAutoFix({ outcome: "exhausted", final_findings: [] })).toBe(
      false,
    );
  });

  test("the operator kill-switch does not park every draft", () => {
    expect(isCleanAutoFix({ outcome: "disabled", final_findings: [] })).toBe(
      true,
    );
  });

  test("a malformed record is not a clean bill of health", () => {
    expect(isCleanAutoFix({ outcome: "clean" })).toBe(false);
    expect(isCleanAutoFix(null)).toBe(false);
  });
});

describe("findingsToNotes", () => {
  const findings = [
    {
      task: "gloss",
      term: "IRGC",
      kind: "acronym",
      excerpt: "The IRGC mobilised.",
      severity: "missing",
      suggestion: "Iran's elite military force",
    },
  ];

  test("renders one note per gloss finding, with the suggestion", () => {
    const notes = findingsToNotes(findings);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("IRGC");
    expect(notes[0]).toContain("Iran's elite military force");
  });

  test("skips tasks that have no recompose remedy", () => {
    expect(
      findingsToNotes([{ ...findings[0]!, task: "source-fidelity" }]),
    ).toEqual([]);
  });

  test("a repeat attempt renders differently from the first", () => {
    // Load-bearing, not cosmetic: the composer is cached on a hash of
    // its rendered input, so identical notes returned the identical
    // brief from ai_call_log and "Re-generate fix" was a no-op.
    const first = findingsToNotes(findings, 1);
    const second = findingsToNotes(findings, 2);
    expect(second).not.toEqual(first);
    expect(second.join("\n")).toContain("attempt 2");
  });

  test("the attempt note is not added when there is nothing to fix", () => {
    // An empty note list must stay empty — a lone "try again" note with
    // no findings would recompose the brief for no reason.
    expect(findingsToNotes([], 3)).toEqual([]);
  });
});

describe("shouldRetryAutoFix", () => {
  const dirty = (attempts: number) => ({
    outcome: "exhausted",
    final_findings: [{ term: "IRGC" }],
    passes: [],
    attempts,
  });

  test("a draft the sweep has never seen gets a run", () => {
    expect(shouldRetryAutoFix(null, 6)).toBe(true);
  });

  test("a dirty draft under the cap gets another run", () => {
    // The point of mig 071: one run then 23 idle hours is what made
    // "the fixer ran" and "the fixer worked" different things.
    expect(shouldRetryAutoFix(dirty(2), 6)).toBe(true);
  });

  test("the lifetime cap stops an unfixable draft burning a call an hour", () => {
    expect(shouldRetryAutoFix(dirty(6), 6)).toBe(false);
    expect(shouldRetryAutoFix(dirty(9), 6)).toBe(false);
  });

  test("a clean draft is left alone", () => {
    expect(
      shouldRetryAutoFix(
        { outcome: "clean", final_findings: [], passes: [], attempts: 1 },
        6,
      ),
    ).toBe(false);
  });

  test("the operator kill-switch is respected", () => {
    expect(
      shouldRetryAutoFix({ outcome: "disabled", final_findings: [], passes: [] }, 6),
    ).toBe(false);
  });

  test("no recompose remedy means retrying is pointless", () => {
    expect(
      shouldRetryAutoFix(
        { outcome: "nothing_to_fix", final_findings: [{}], passes: [] },
        6,
      ),
    ).toBe(false);
  });

  test("a pre-mig-071 log falls back to counting its passes", () => {
    expect(
      shouldRetryAutoFix(
        { outcome: "exhausted", final_findings: [{}], passes: [{}, {}] },
        2,
      ),
    ).toBe(false);
  });
});

describe("the run counter is the loop's hard bound", () => {
  // The storage incident: two early-exit paths returned without
  // incrementing `attempts`, and shouldRetryAutoFix treats
  // outcome="failed" as retryable — so those drafts re-ran every hour
  // forever, each run rewriting a jsonb column that (until mig 073) held
  // three copies of the brief. Counting invocations terminates the loop
  // even when a path forgets to count its own work.
  test("a failed run with no attempts spent still converges", () => {
    const stuck = (runs: number) => ({
      outcome: "failed",
      final_findings: [{ term: "IRGC" }],
      passes: [],
      attempts: 0, // the bug: never incremented on this path
      runs,
    });
    expect(shouldRetryAutoFix(stuck(1), 6)).toBe(true);
    expect(shouldRetryAutoFix(stuck(5), 6)).toBe(true);
    // Without the runs bound this would be true forever.
    expect(shouldRetryAutoFix(stuck(6), 6)).toBe(false);
    expect(shouldRetryAutoFix(stuck(40), 6)).toBe(false);
  });

  test("a pre-mig-073 log with no runs field still honours the attempts cap", () => {
    expect(
      shouldRetryAutoFix(
        { outcome: "exhausted", final_findings: [{}], passes: [], attempts: 6 },
        6,
      ),
    ).toBe(false);
  });

  test("the audit trail keeps findings, not prose", () => {
    // mig 073: prose lives in ai_call_log. A log carrying a full brief
    // is the regression this pins.
    const log: AutoFixLog = {
      passes: [
        {
          pass: 1,
          at: "2026-08-04T00:00:00.000Z",
          notes: ["gloss IRGC"],
          findings_before: [],
          findings_after: [],
          improved: true,
          markdown_before_sha: markdownSha("prose"),
        },
      ],
      final_findings: [],
      outcome: "clean",
      attempts: 1,
      runs: 1,
      original_findings: [],
      original_markdown_sha: markdownSha("prose"),
    };
    const serialized = JSON.stringify(log);
    expect(serialized).not.toContain("markdown_before\"");
    expect(serialized).not.toContain("original_markdown\"");
    // A whole run's record should be small enough to rewrite hourly
    // without it mattering.
    expect(serialized.length).toBeLessThan(2048);
  });
});
