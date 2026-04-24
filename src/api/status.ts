// Pipeline-freshness metrics. Used by /health (JSON for cron/uptime
// checks) and /admin/status (HTML for the operator). One query builder
// here, two renderers at the call sites.

import { sql } from "kysely";
import { db } from "../db/index.ts";

export interface PipelineStatus {
  db_ok: boolean;
  last_ingest_at: Date | null;
  last_ingest_age_sec: number | null;
  last_score_at: Date | null;
  last_score_age_sec: number | null;
  last_issue_at: Date | null;
  last_issue_age_sec: number | null;
  unscored_backlog: number;
  today_spend_usd: number;
  daily_cap_usd: number | null;
  budget_remaining_usd: number | null;
}

export async function loadPipelineStatus(): Promise<PipelineStatus> {
  let db_ok = true;
  try {
    await sql`SELECT 1`.execute(db);
  } catch {
    db_ok = false;
  }
  if (!db_ok) {
    return {
      db_ok,
      last_ingest_at: null,
      last_ingest_age_sec: null,
      last_score_at: null,
      last_score_age_sec: null,
      last_issue_at: null,
      last_issue_age_sec: null,
      unscored_backlog: 0,
      today_spend_usd: 0,
      daily_cap_usd: null,
      budget_remaining_usd: null,
    };
  }

  const now = Date.now();

  const lastIngestRow = await db
    .selectFrom("story")
    .select(sql<Date | null>`max(ingested_at)`.as("t"))
    .executeTakeFirst();
  const lastIngestAt = lastIngestRow?.t ?? null;

  const lastScoreRow = await db
    .selectFrom("story")
    .select(sql<Date | null>`max(scored_at)`.as("t"))
    .executeTakeFirst();
  const lastScoreAt = lastScoreRow?.t ?? null;

  const lastIssueRow = await db
    .selectFrom("issue")
    .select(sql<Date | null>`max(published_at)`.as("t"))
    .where("is_draft", "=", false)
    .executeTakeFirst();
  const lastIssueAt = lastIssueRow?.t ?? null;

  const backlogRow = await db
    .selectFrom("story")
    .select(sql<string>`count(*)`.as("n"))
    .where("scored_at", "is", null)
    .where("early_reject", "=", false)
    .executeTakeFirst();
  const backlog = Number(backlogRow?.n ?? 0);

  const startOfDay = new Date(
    Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate(),
    ),
  );
  const spendRow = await db
    .selectFrom("ai_call_log")
    .select(sql<string | null>`coalesce(sum(cost_estimate_usd), 0)`.as("s"))
    .where("started_at", ">=", startOfDay)
    .executeTakeFirst();
  const todaySpend = Number(spendRow?.s ?? 0);

  const capRow = await db
    .selectFrom("config")
    .select("value")
    .where("key", "=", "budget.daily_usd_cap")
    .executeTakeFirst();
  const cap = capRow ? Number(capRow.value) : null;
  const capFinite = cap !== null && Number.isFinite(cap) ? cap : null;

  return {
    db_ok,
    last_ingest_at: lastIngestAt,
    last_ingest_age_sec:
      lastIngestAt !== null
        ? Math.floor((now - lastIngestAt.getTime()) / 1000)
        : null,
    last_score_at: lastScoreAt,
    last_score_age_sec:
      lastScoreAt !== null
        ? Math.floor((now - lastScoreAt.getTime()) / 1000)
        : null,
    last_issue_at: lastIssueAt,
    last_issue_age_sec:
      lastIssueAt !== null
        ? Math.floor((now - lastIssueAt.getTime()) / 1000)
        : null,
    unscored_backlog: backlog,
    today_spend_usd: todaySpend,
    daily_cap_usd: capFinite,
    budget_remaining_usd:
      capFinite !== null ? Math.max(0, capFinite - todaySpend) : null,
  };
}
