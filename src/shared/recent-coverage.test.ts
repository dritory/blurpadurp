import { describe, expect, test } from "bun:test";
import {
  buildRecentCoverage,
  type CoverageIssueRow,
  type CoveragePickRow,
} from "./recent-coverage.ts";

const NOW = new Date("2026-08-15T00:00:00Z");

function issue(id: number, date: string, title = `issue ${id}`): CoverageIssueRow {
  return { issue_id: id, published_at: new Date(`${date}T06:00:00Z`), title };
}

function pick(
  issueId: number,
  themeId: number | null,
  section = "conversation",
  summary = "something happened",
): CoveragePickRow {
  return {
    issue_id: issueId,
    theme_id: themeId,
    theme_name: themeId !== null ? `theme ${themeId}` : null,
    section,
    summary,
  };
}

describe("buildRecentCoverage", () => {
  test("groups picks under their issue and dates each one in weeks", () => {
    const res = buildRecentCoverage(
      [issue(2, "2026-08-08"), issue(1, "2026-07-25")],
      [pick(2, 10), pick(1, 11)],
      NOW,
    );
    expect(res.issues.map((i) => i.weeks_ago)).toEqual([1, 3]);
    expect(res.issues[0]!.items).toHaveLength(1);
    expect(res.issues[0]!.published_at).toBe("2026-08-08");
  });

  test("a theme picked twice in one issue counts as one issue of coverage", () => {
    // An arc expands to several issue_pick rows under one theme. Counting
    // picks would make it look twice as repetitive as it is.
    const res = buildRecentCoverage(
      [issue(1, "2026-08-08")],
      [pick(1, 10), pick(1, 10), pick(1, 10)],
      NOW,
    );
    expect(res.byTheme.get(10)!.issue_count).toBe(1);
  });

  test("counts a theme once per issue across issues", () => {
    const res = buildRecentCoverage(
      [issue(3, "2026-08-08"), issue(2, "2026-08-01"), issue(1, "2026-07-25")],
      [pick(3, 10), pick(2, 10), pick(1, 10), pick(1, 20)],
      NOW,
    );
    expect(res.byTheme.get(10)!.issue_count).toBe(3);
    expect(res.byTheme.get(20)!.issue_count).toBe(1);
  });

  test("last_covered_* comes from the most recent issue, not the oldest", () => {
    const res = buildRecentCoverage(
      [issue(2, "2026-08-08"), issue(1, "2026-08-01")],
      [
        pick(2, 10, "conversation", "newest thing"),
        pick(1, 10, "worth_knowing", "older thing"),
      ],
      NOW,
    );
    const cov = res.byTheme.get(10)!;
    expect(cov.last_covered_date).toBe("2026-08-08");
    expect(cov.last_covered_summary).toBe("newest thing");
    expect(cov.led_last_time).toBe(true);
  });

  test("led_last_time is false when the theme was not in the lead section", () => {
    const res = buildRecentCoverage(
      [issue(1, "2026-08-08")],
      [pick(1, 10, "worth_watching")],
      NOW,
    );
    expect(res.byTheme.get(10)!.led_last_time).toBe(false);
  });

  test("unthemed picks are kept as items but never enter the rollup", () => {
    const res = buildRecentCoverage(
      [issue(1, "2026-08-08")],
      [pick(1, null)],
      NOW,
    );
    expect(res.issues[0]!.items).toHaveLength(1);
    expect(res.byTheme.size).toBe(0);
  });

  test("an issue with no picks still appears, with no items", () => {
    const res = buildRecentCoverage([issue(1, "2026-08-08")], [], NOW);
    expect(res.issues).toHaveLength(1);
    expect(res.issues[0]!.items).toEqual([]);
  });

  test("an issue published today reads as this week, not negative weeks", () => {
    const res = buildRecentCoverage([issue(1, "2026-08-15")], [], NOW);
    expect(res.issues[0]!.weeks_ago).toBe(0);
  });
});
