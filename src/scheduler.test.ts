import { describe, expect, test } from "bun:test";
import { anchoredStageDue, nextAnchoredRun } from "./scheduler.ts";

// The calendar anchor (mig 066) exists because interval scheduling let
// the draft day drift: "604800s since last success" moved forward by
// the run duration plus tick granularity every week, and a manual
// trigger re-anchored it permanently. These lock the replacement.
//
// Reference instants (all UTC):
//   2026-08-01T06:00:00Z is a Saturday (dow 6)
//   2026-08-02T06:00:00Z is a Sunday   (dow 0)
const SAT_06 = new Date("2026-08-01T06:00:00Z");
const SAT_05 = new Date("2026-08-01T05:59:00Z");
const SAT_23 = new Date("2026-08-01T23:30:00Z");
const SUN_06 = new Date("2026-08-02T06:00:00Z");

const anchor = { cron_dow: 6, cron_hour: 6 };

describe("anchoredStageDue", () => {
  test("fires on the anchored weekday once the hour arrives", () => {
    expect(
      anchoredStageDue({ ...anchor, last_success_at: null }, SAT_06),
    ).toBe(true);
  });

  test("does not fire before the anchored hour", () => {
    expect(
      anchoredStageDue({ ...anchor, last_success_at: null }, SAT_05),
    ).toBe(false);
  });

  test("does not fire on other weekdays", () => {
    expect(
      anchoredStageDue({ ...anchor, last_success_at: null }, SUN_06),
    ).toBe(false);
  });

  // The drift guard: a run that completed at 06:05 must not leave the
  // stage eligible again later the same day.
  test("does not re-fire later the same day", () => {
    const ranAt = new Date("2026-08-01T06:05:00Z");
    expect(
      anchoredStageDue({ ...anchor, last_success_at: ranAt }, SAT_23),
    ).toBe(false);
  });

  // ...but a week later it must, even though the previous success is
  // only ~167h old — an interval check would have deferred this one.
  test("fires again the following week", () => {
    const ranAt = new Date("2026-08-01T06:05:00Z");
    const nextSat = new Date("2026-08-08T06:00:00Z");
    expect(
      anchoredStageDue({ ...anchor, last_success_at: ranAt }, nextSat),
    ).toBe(true);
  });

  // A stage that missed its slot entirely (machine down all Saturday)
  // waits for the next one rather than firing on the wrong day. Landing
  // on the right day is the whole point of the anchor.
  test("a missed slot does not fire on the following day", () => {
    const stale = new Date("2026-07-25T06:00:00Z");
    expect(
      anchoredStageDue({ ...anchor, last_success_at: stale }, SUN_06),
    ).toBe(false);
  });

  test("unanchored rows are never due via this path", () => {
    expect(
      anchoredStageDue(
        { cron_dow: null, cron_hour: null, last_success_at: null },
        SAT_06,
      ),
    ).toBe(false);
  });

  // A half-set pair is rejected by a CHECK constraint in mig 066, but
  // the predicate must not treat it as anchored if one ever appears.
  test("a half-set anchor is not due", () => {
    expect(
      anchoredStageDue(
        { cron_dow: 6, cron_hour: null, last_success_at: null },
        SAT_06,
      ),
    ).toBe(false);
  });
});

// The /admin/scheduler "next due" projection. Must agree with
// anchoredStageDue — a page that predicts a slot the scheduler skips is
// how the drift went unnoticed the first time.
describe("nextAnchoredRun", () => {
  test("today, when the slot is still ahead", () => {
    expect(
      nextAnchoredRun(6, 6, null, SAT_05).toISOString(),
    ).toBe("2026-08-01T06:00:00.000Z");
  });

  test("today, when the slot has arrived and nothing has run", () => {
    expect(
      nextAnchoredRun(6, 6, null, SAT_06).toISOString(),
    ).toBe("2026-08-01T06:00:00.000Z");
  });

  test("next week, once today's run is done", () => {
    const ranAt = new Date("2026-08-01T06:05:00Z");
    expect(
      nextAnchoredRun(6, 6, ranAt, SAT_23).toISOString(),
    ).toBe("2026-08-08T06:00:00.000Z");
  });

  test("counts forward from a non-anchor weekday", () => {
    // Sunday → the coming Saturday is six days out.
    expect(
      nextAnchoredRun(6, 6, null, SUN_06).toISOString(),
    ).toBe("2026-08-08T06:00:00.000Z");
  });

  // Whatever nextAnchoredRun points at must be a slot the scheduler
  // actually accepts.
  test("agrees with anchoredStageDue at the instant it predicts", () => {
    const ranAt = new Date("2026-08-01T06:05:00Z");
    const next = nextAnchoredRun(6, 6, ranAt, SAT_23);
    expect(
      anchoredStageDue({ cron_dow: 6, cron_hour: 6, last_success_at: ranAt }, next),
    ).toBe(true);
  });
});
