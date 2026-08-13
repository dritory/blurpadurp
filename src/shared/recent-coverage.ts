// Prior-issue memory.
//
// The brief had no way to know what it had already told the reader. Per
// theme it knew a count (theme.n_stories_published) and, for the
// composer, a timeline of story one-liners — but nothing said "issue #41
// led with this two weeks ago". So a running story could be re-picked
// and re-explained week after week, each issue individually defensible
// and the sequence repetitive. This is the missing half.
//
// It reads from issue_pick, which already records (issue, story, section,
// rank) for every published issue — so there is no new write path and no
// new table, just a query nobody had written yet.

import { db } from "../db/index.ts";

export interface CoverageItem {
  theme_id: number | null;
  theme_name: string | null;
  section: string;
  summary: string;
}

export interface CoveredIssue {
  issue_id: number;
  published_at: string; // YYYY-MM-DD
  title: string | null;
  /** Whole weeks between that issue and now. 0 = this week. */
  weeks_ago: number;
  items: CoverageItem[];
}

export interface ThemeCoverage {
  /** How many of the loaded issues carried this theme. */
  issue_count: number;
  /** Most recent issue date that carried it, YYYY-MM-DD. */
  last_covered_date: string;
  /** What that issue said about it — the scorer one-liner of the most
   *  recent story under this theme, which is the closest thing we have
   *  to "what the reader was told" without storing prose per theme. */
  last_covered_summary: string;
  /** True when the theme appeared in the conversation (lead) section of
   *  the most recent issue that carried it. */
  led_last_time: boolean;
}

export interface RecentCoverage {
  issues: CoveredIssue[];
  byTheme: Map<number, ThemeCoverage>;
}

export const EMPTY_COVERAGE: RecentCoverage = {
  issues: [],
  byTheme: new Map(),
};

// Cap on items rendered per prior issue. A brief runs 10-15 picks, so
// this is "all of them" in practice; it exists so a pathological issue
// can't balloon the editor prompt.
const MAX_ITEMS_PER_ISSUE = 20;

/**
 * Load what the last `maxIssues` published issues covered.
 *
 * Drafts are excluded: an unpublished draft was never read by anyone, so
 * counting it as coverage would suppress a story the reader never saw.
 * Event-driven (urgent) issues ARE included — the reader did receive
 * those, which is the only thing that matters here.
 */
export async function loadRecentCoverage(
  maxIssues: number,
  now: Date = new Date(),
): Promise<RecentCoverage> {
  if (maxIssues <= 0) return EMPTY_COVERAGE;

  const issues = await db
    .selectFrom("issue")
    .select(["id", "published_at", "title"])
    .where("is_draft", "=", false)
    .orderBy("published_at", "desc")
    .limit(maxIssues)
    .execute();
  if (issues.length === 0) return EMPTY_COVERAGE;

  const issueIds = issues.map((i) => Number(i.id));
  const picks = await db
    .selectFrom("issue_pick")
    .innerJoin("story", "story.id", "issue_pick.story_id")
    .leftJoin("theme", "theme.id", "story.theme_id")
    .select([
      "issue_pick.issue_id",
      "issue_pick.section",
      "issue_pick.rank",
      "story.theme_id",
      "theme.name as theme_name",
      // scorer_summary is the denormalized one-liner (mig 055) and is
      // always inline — deliberately not raw_output, which cold-tiers to
      // R2 and would make this query fetch from object storage.
      "story.scorer_summary",
      "story.title as story_title",
      "story.published_to_reader_at",
    ])
    .where("issue_pick.issue_id", "in", issueIds)
    .orderBy("issue_pick.rank", "asc")
    .execute();

  return buildRecentCoverage(
    issues.map((i) => ({
      issue_id: Number(i.id),
      published_at: i.published_at,
      title: i.title,
    })),
    picks.map((p) => ({
      issue_id: Number(p.issue_id),
      theme_id: p.theme_id !== null ? Number(p.theme_id) : null,
      theme_name: p.theme_name,
      section: p.section,
      summary:
        p.scorer_summary !== null && p.scorer_summary.trim() !== ""
          ? p.scorer_summary.trim()
          : p.story_title,
    })),
    now,
  );
}

export interface CoverageIssueRow {
  issue_id: number;
  published_at: Date;
  title: string | null;
}

export interface CoveragePickRow {
  issue_id: number;
  theme_id: number | null;
  theme_name: string | null;
  section: string;
  summary: string;
}

/**
 * Shape rows into the coverage digest. Pure — split out from the query
 * so the counting rules below are testable without a database.
 *
 * `issues` must be newest-first; `picks` must be in rank order within an
 * issue, which is how the caller queries them.
 */
export function buildRecentCoverage(
  issues: CoverageIssueRow[],
  picks: CoveragePickRow[],
  now: Date,
): RecentCoverage {
  const itemsByIssue = new Map<number, CoverageItem[]>();
  for (const p of picks) {
    const list = itemsByIssue.get(p.issue_id) ?? [];
    if (list.length >= MAX_ITEMS_PER_ISSUE) continue;
    list.push({
      theme_id: p.theme_id,
      theme_name: p.theme_name,
      section: p.section,
      summary: p.summary,
    });
    itemsByIssue.set(p.issue_id, list);
  }

  const covered: CoveredIssue[] = issues.map((i) => ({
    issue_id: i.issue_id,
    published_at: i.published_at.toISOString().slice(0, 10),
    title: i.title,
    // Rounded, not floored. Compose runs Saturday morning against an
    // issue published the previous Saturday morning — 6.8 days, which
    // floors to 0 and would tell the model "this week" about the issue
    // the reader got last week. The prompts render this number as prose
    // ("1 week ago"), so it has to match how a person would say it.
    weeks_ago: Math.max(
      0,
      Math.round(
        (now.getTime() - i.published_at.getTime()) / (7 * 24 * 3600_000),
      ),
    ),
    items: itemsByIssue.get(i.issue_id) ?? [],
  }));

  // Per-theme rollup. `covered` is newest-first, so the first issue that
  // mentions a theme is the most recent one that did.
  const byTheme = new Map<number, ThemeCoverage>();
  // Same theme twice inside one issue (an arc, or two picks off one
  // theme) is still ONE issue of coverage. Counting picks would make an
  // arc look like a theme we run twice as often as we do — which is the
  // exact judgment this number exists to inform.
  const countedPairs = new Set<string>();
  for (const issue of covered) {
    for (const item of issue.items) {
      if (item.theme_id === null) continue;
      const pair = `${issue.issue_id}:${item.theme_id}`;
      if (countedPairs.has(pair)) continue;
      countedPairs.add(pair);
      const existing = byTheme.get(item.theme_id);
      if (existing === undefined) {
        byTheme.set(item.theme_id, {
          issue_count: 1,
          last_covered_date: issue.published_at,
          last_covered_summary: item.summary,
          led_last_time: item.section === "conversation",
        });
        continue;
      }
      existing.issue_count += 1;
    }
  }

  return { issues: covered, byTheme };
}
