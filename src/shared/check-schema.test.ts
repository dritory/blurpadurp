import { describe, expect, test } from "bun:test";
import {
  isCheckCurrent,
  isCleanAutoFix,
  markdownSha,
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
