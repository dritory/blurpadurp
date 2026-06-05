// Shared building blocks for rendering the public reader pages.
//
// Both the live routes (api/index.tsx) and the publish-time static
// export (pipeline/static-export.tsx) turn published-issue rows into the
// same IssueView and apply the same home-page staleness logic. They
// can't share a router (importing index.tsx would boot an HTTP
// listener), but the pure mapping + the staleness rule have no such
// constraint — they live here so the two paths can't silently drift.
// The type-only view imports are erased at runtime.

import type { HomeViewData } from "../views/home.tsx";
import type { IssueView } from "../views/issue.tsx";
import { getConfigNumber } from "./config-store.ts";

// A published-issue row carrying exactly the columns IssueView needs.
// Field types are kept loose on `id` so a Kysely row (number) and a
// hand-built test row both satisfy it.
export interface IssueViewRow {
  id: number | string | bigint;
  published_seq: number | null;
  published_at: Date;
  is_event_driven: boolean;
  title: string | null;
  composed_html: string;
}

export function mapIssueRow(row: IssueViewRow): IssueView {
  return {
    id: Number(row.id),
    publishedSeq: row.published_seq,
    publishedAt: row.published_at,
    isEventDriven: row.is_event_driven,
    title: row.title,
    html: row.composed_html,
  };
}

export const HOME_STALENESS_DEFAULT_DAYS = 8;

export function loadHomeStalenessThresholdDays(): Promise<number> {
  return getConfigNumber(
    "home.staleness_threshold_days",
    HOME_STALENESS_DEFAULT_DAYS,
  );
}

// Decide which of the three home-page states to render from the latest
// issue and the staleness threshold: fresh issue, silence (with a
// deep-link to the last brief), or never-published.
export function buildHomeView(
  latest: IssueView | null,
  thresholdDays: number,
): HomeViewData {
  if (latest === null) return { kind: "empty" };
  const ageMs = Date.now() - latest.publishedAt.getTime();
  if (ageMs > thresholdDays * 24 * 3600_000) {
    return {
      kind: "silent",
      lastIssue: {
        id: latest.id,
        publishedSeq: latest.publishedSeq,
        publishedAt: latest.publishedAt,
        title: latest.title,
      },
    };
  }
  return { kind: "issue", issue: latest };
}
