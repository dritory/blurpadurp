import { describe, expect, test } from "bun:test";
import {
  isWithinDeepSeekOffPeak,
  minutesUntilOffPeakStart,
} from "./off-peak.ts";

// Off-peak window is UTC 16:30 – 00:30 (crosses midnight).
function at(h: number, m: number): Date {
  return new Date(Date.UTC(2026, 0, 1, h, m, 0));
}

describe("isWithinDeepSeekOffPeak", () => {
  test("inside the window: after 16:30 and before 00:30", () => {
    expect(isWithinDeepSeekOffPeak(at(16, 30))).toBe(true); // boundary start
    expect(isWithinDeepSeekOffPeak(at(20, 0))).toBe(true);
    expect(isWithinDeepSeekOffPeak(at(23, 59))).toBe(true);
    expect(isWithinDeepSeekOffPeak(at(0, 0))).toBe(true);
    expect(isWithinDeepSeekOffPeak(at(0, 29))).toBe(true);
  });

  test("outside the window: 00:30 .. 16:29", () => {
    expect(isWithinDeepSeekOffPeak(at(0, 30))).toBe(false); // boundary end (exclusive)
    expect(isWithinDeepSeekOffPeak(at(9, 0))).toBe(false);
    expect(isWithinDeepSeekOffPeak(at(16, 29))).toBe(false);
  });
});

describe("minutesUntilOffPeakStart", () => {
  test("zero while already off-peak", () => {
    expect(minutesUntilOffPeakStart(at(18, 0))).toBe(0);
    expect(minutesUntilOffPeakStart(at(0, 0))).toBe(0);
  });

  test("counts minutes up to the next 16:30 when on-peak", () => {
    expect(minutesUntilOffPeakStart(at(16, 0))).toBe(30);
    expect(minutesUntilOffPeakStart(at(15, 30))).toBe(60);
  });
});
