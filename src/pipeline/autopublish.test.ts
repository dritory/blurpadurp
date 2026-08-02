import { describe, expect, test } from "bun:test";
import { isCleanAutoFix as isCleanLog } from "../shared/check-schema.ts";
import { autopublishDecision } from "./autopublish.ts";

// isCleanLog is the last gate before an issue is mailed, and email is
// irreversible (dispatch_log is at-most-once, no recall). Every
// ambiguous input must therefore resolve to NOT clean — a draft that
// merely fails to prove itself safe gets held, not sent.

describe("isCleanLog", () => {
  test("clean outcome with no remaining findings publishes", () => {
    expect(isCleanLog({ outcome: "clean", final_findings: [] })).toBe(true);
  });

  test("auto-fix turned off publishes — operator disabled the fixer, not the release", () => {
    expect(isCleanLog({ outcome: "disabled", final_findings: [] })).toBe(true);
  });

  test("exhausted passes hold", () => {
    expect(
      isCleanLog({ outcome: "exhausted", final_findings: [{ term: "VRA" }] }),
    ).toBe(false);
  });

  test("checker or composer failure holds", () => {
    expect(isCleanLog({ outcome: "failed", final_findings: [] })).toBe(false);
  });

  test("findings with no recompose remedy hold", () => {
    expect(
      isCleanLog({ outcome: "nothing_to_fix", final_findings: [{ term: "x" }] }),
    ).toBe(false);
  });

  // "clean" plus leftover findings is a contradiction; trust the
  // findings, not the label.
  test("clean label contradicted by findings holds", () => {
    expect(
      isCleanLog({ outcome: "clean", final_findings: [{ term: "OPEC" }] }),
    ).toBe(false);
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "clean"],
    ["a number", 1],
    ["an empty object", {}],
    ["an unknown outcome", { outcome: "weird", final_findings: [] }],
    ["a missing findings array", { outcome: "clean" }],
  ])("%s holds", (_label, input) => {
    expect(isCleanLog(input)).toBe(false);
  });
});

// The staleness ceiling (mig 068). autopublish originally published a
// draft of ANY age once past its 24h deadline, so deploying it with a
// forgotten draft already open would mail a weeks-old brief on the
// first sweep — wrong lead, false "this week" framing, and it burns
// every story the draft holds via published_to_reader.
//
// The load-bearing property is that the ceiling EXISTS: delete it and
// the two cases below go from "hold" to "due", which is the bug.
// (Guard order matters less than it looks — with maxAge > deadline both
// orderings agree. It only bites on a misconfigured maxAge < deadline,
// where checking the ceiling first fails safe.)
describe("autopublishDecision", () => {
  const H = 3600_000;
  const base = { deadlineMs: 24 * H, maxAgeMs: 72 * H, enabled: true };

  test("inside the deadline → wait", () => {
    expect(autopublishDecision({ ...base, ageMs: 5 * H })).toBe("wait");
  });

  test("past the deadline, inside the ceiling → due", () => {
    expect(autopublishDecision({ ...base, ageMs: 30 * H })).toBe("due");
  });

  // The regression. 21 days is past BOTH thresholds; hold must win.
  test("past the ceiling → hold, never due", () => {
    expect(autopublishDecision({ ...base, ageMs: 21 * 24 * H })).toBe(
      "hold_stale",
    );
  });

  test("a late-but-reasonable sweep still publishes", () => {
    // Scheduler machine down for a day: 48h old, past the 24h deadline
    // but well inside the 72h ceiling. Must NOT be treated as stale.
    expect(autopublishDecision({ ...base, ageMs: 48 * H })).toBe("due");
  });

  test("exactly at the ceiling is not yet stale", () => {
    expect(autopublishDecision({ ...base, ageMs: 72 * H })).toBe("due");
  });

  test("one ms past the ceiling is stale", () => {
    expect(autopublishDecision({ ...base, ageMs: 72 * H + 1 })).toBe(
      "hold_stale",
    );
  });

  // With auto-publish off nothing would ship the draft anyway, so
  // holding would be noise rather than protection.
  test("auto-publish off → never holds for staleness", () => {
    expect(
      autopublishDecision({ ...base, enabled: false, ageMs: 21 * 24 * H }),
    ).toBe("due");
  });

  test("no drafted_at → skipped, not published", () => {
    expect(autopublishDecision({ ...base, ageMs: null })).toBe(
      "skip_no_timestamp",
    );
  });
});

// Misconfiguration: someone sets the ceiling below the deadline. The
// ceiling should still win, so nothing ships rather than everything.
describe("autopublishDecision — ceiling below deadline", () => {
  const H = 3600_000;
  test("holds instead of publishing", () => {
    expect(
      autopublishDecision({
        ageMs: 10 * H,
        deadlineMs: 24 * H,
        maxAgeMs: 6 * H,
        enabled: true,
      }),
    ).toBe("hold_stale");
  });
});
