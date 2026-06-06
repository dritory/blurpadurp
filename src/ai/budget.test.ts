import { describe, expect, test } from "bun:test";
import {
  BudgetExceededError,
  assertWithinBudget,
  startOfUtcDay,
} from "./budget-core.ts";

describe("assertWithinBudget", () => {
  test("null cap disables the guard (never throws)", () => {
    expect(() => assertWithinBudget(1_000_000, null)).not.toThrow();
  });

  test("spend below cap does not throw", () => {
    expect(() => assertWithinBudget(4.99, 5)).not.toThrow();
  });

  test("spend exactly at cap trips it (>= ceiling, not target)", () => {
    expect(() => assertWithinBudget(5, 5)).toThrow(BudgetExceededError);
  });

  test("spend over cap throws with the spent/cap carried on the error", () => {
    try {
      assertWithinBudget(7.5, 5);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExceededError);
      const be = e as BudgetExceededError;
      expect(be.spentUsd).toBe(7.5);
      expect(be.capUsd).toBe(5);
    }
  });
});

describe("startOfUtcDay", () => {
  test("truncates to UTC midnight", () => {
    const d = startOfUtcDay(new Date("2026-06-05T17:43:21.123Z"));
    expect(d.toISOString()).toBe("2026-06-05T00:00:00.000Z");
  });

  test("uses UTC date even near a day boundary in another zone", () => {
    // 23:30 UTC is still the same UTC day.
    const d = startOfUtcDay(new Date("2026-01-01T23:30:00.000Z"));
    expect(d.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});
