import { describe, expect, test } from "bun:test";
import { isCleanAutoFix as isCleanLog } from "../shared/check-schema.ts";

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
