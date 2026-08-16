// DB reads behind the health snapshot. The judgement lives next door in
// pipeline-health.ts, which is pure and tested; this file only fetches.

import { sql } from "kysely";
import { db } from "../db/index.ts";
import { startOfUtcDay } from "../ai/budget-core.ts";
import { getConfigNumber, getConfigNumberOrNull } from "./config-store.ts";
import {
  assessStage,
  type DraftFacts,
  type HealthSnapshot,
  type StageFacts,
  type StageHealth,
} from "./pipeline-health.ts";

/** Config key holding the last time a heartbeat mail actually went out. */
export const LAST_SENT_KEY = "heartbeat.last_sent_at";

/**
 * Per stage: cadence and enabled flag from `pipeline_schedule`, plus the
 * tail of `pipeline_run` needed to count the current failure streak.
 *
 * One query rather than six round-trips per stage, because this runs on
 * a machine whose whole job is to wake Neon as briefly as possible.
 */
async function loadStageFacts(): Promise<StageFacts[]> {
  const rows = await sql<{
    stage: string;
    enabled: boolean;
    interval_sec: number;
    anchored: boolean;
    last_success_at: Date | null;
    last_status: string | null;
    last_error: string | null;
    consecutive_failures: string;
    failing_since: Date | null;
  }>`
    WITH last_success AS (
      SELECT stage, max(completed_at) AS at
      FROM pipeline_run
      WHERE status = 'success'
      GROUP BY stage
    ),
    last_attempt AS (
      SELECT DISTINCT ON (stage) stage, status, error
      FROM pipeline_run
      ORDER BY stage, started_at DESC
    ),
    -- Attempts since the last success. A stage that has never succeeded
    -- counts every attempt it has ever made, which is the honest answer.
    streak AS (
      SELECT r.stage,
             count(*) FILTER (WHERE r.status = 'error') AS failures,
             min(r.started_at) FILTER (WHERE r.status = 'error') AS since
      FROM pipeline_run r
      LEFT JOIN last_success s ON s.stage = r.stage
      WHERE s.at IS NULL OR r.started_at > s.at
      GROUP BY r.stage
    )
    SELECT ps.stage,
           ps.enabled,
           ps.interval_sec,
           (ps.cron_dow IS NOT NULL AND ps.cron_hour IS NOT NULL) AS anchored,
           ls.at        AS last_success_at,
           la.status    AS last_status,
           la.error     AS last_error,
           coalesce(st.failures, 0)::text AS consecutive_failures,
           st.since     AS failing_since
    FROM pipeline_schedule ps
    LEFT JOIN last_success ls ON ls.stage = ps.stage
    LEFT JOIN last_attempt la ON la.stage = ps.stage
    LEFT JOIN streak st       ON st.stage = ps.stage
    ORDER BY ps.stage
  `.execute(db);

  return rows.rows.map((r) => ({
    stage: r.stage,
    enabled: r.enabled,
    intervalSec: Number(r.interval_sec),
    anchored: r.anchored,
    lastSuccessAt: r.last_success_at,
    lastStatus: r.last_status,
    lastError: r.last_error,
    consecutiveFailures: Number(r.consecutive_failures),
    failingSince: r.failing_since,
  }));
}

/**
 * Consecutive failures for one stage. Used by the scheduler's own error
 * path, where the count decides whether the failure is worth a mail
 * (`shouldNotifyFailure`) — the row for the current failure is already
 * written by the time this is called.
 */
export async function countConsecutiveFailures(stage: string): Promise<number> {
  const row = await sql<{ n: string }>`
    SELECT count(*) FILTER (WHERE status = 'error')::text AS n
    FROM pipeline_run
    WHERE stage = ${stage}
      AND started_at > coalesce(
        (SELECT max(completed_at) FROM pipeline_run
          WHERE stage = ${stage} AND status = 'success'),
        '-infinity'::timestamptz
      )
  `.execute(db);
  return Number(row.rows[0]?.n ?? 0);
}

async function loadDraft(): Promise<DraftFacts | null> {
  const row = await db
    .selectFrom("issue")
    .select(["id", "drafted_at", "hold"])
    .where("is_draft", "=", true)
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  if (row === undefined) return null;

  const [publishAfterHours, maxAgeHours] = await Promise.all([
    getConfigNumber("compose.auto_publish_hours", 24),
    getConfigNumber("compose.auto_publish_max_age_hours", 72),
  ]);

  return {
    issueId: row.id,
    draftedAt: row.drafted_at,
    hold: row.hold,
    publishAfterHours,
    maxAgeHours,
  };
}

/**
 * Logical size of the database. Worth watching because the failure it
 * catches doesn't look like a storage failure from anywhere else: when
 * the auto-fix retry loop rewrote three copies of the brief hourly,
 * Neon filled and it surfaced as "publish crashes" (runbook #14).
 *
 * Caveat carried into the alert text: on Neon, billed storage includes
 * branch history for the PITR window, so this number is a floor, not
 * the bill. Logical deletes don't shrink it until history rolls.
 */
async function loadDbBytes(): Promise<number | null> {
  try {
    const row = await sql<{ bytes: string }>`
      SELECT pg_database_size(current_database())::text AS bytes
    `.execute(db);
    const bytes = Number(row.rows[0]?.bytes ?? Number.NaN);
    return Number.isFinite(bytes) ? bytes : null;
  } catch {
    // Not worth failing the heartbeat over — the rest of the digest is
    // still useful, and this is the one field a restricted role might
    // not be able to read.
    return null;
  }
}

export async function loadHealthSnapshot(
  now: Date = new Date(),
): Promise<HealthSnapshot> {
  const [facts, draft, dbBytes] = await Promise.all([
    loadStageFacts(),
    loadDraft(),
    loadDbBytes(),
  ]);

  const backlogRow = await db
    .selectFrom("story")
    .select(sql<string>`count(*)`.as("n"))
    .where("scored_at", "is", null)
    .where("early_reject", "=", false)
    .executeTakeFirst();

  const spendRow = await db
    .selectFrom("ai_call_log")
    .select(sql<string | null>`coalesce(sum(cost_estimate_usd), 0)`.as("spent"))
    .where("started_at", ">=", startOfUtcDay())
    .executeTakeFirst();

  const [dailyCapUsd, dbBudgetMb] = await Promise.all([
    getConfigNumberOrNull("budget.daily_usd_cap"),
    getConfigNumberOrNull("storage.db_budget_mb"),
  ]);

  const stages: StageHealth[] = facts.map((f) => assessStage(f, now));

  return {
    now,
    stages,
    draft,
    unscoredBacklog: Number(backlogRow?.n ?? 0),
    todaySpendUsd: Number(spendRow?.spent ?? 0),
    dailyCapUsd,
    dbBytes,
    dbBudgetBytes: dbBudgetMb === null ? null : dbBudgetMb * 1024 * 1024,
  };
}

export async function loadLastHeartbeatSentAt(): Promise<Date | null> {
  const row = await db
    .selectFrom("config")
    .select("value")
    .where("key", "=", LAST_SENT_KEY)
    .executeTakeFirst();
  if (row === undefined) return null;
  const raw = typeof row.value === "string" ? row.value : String(row.value);
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Record that a heartbeat went out. One small `config` row, written at
 * most once a day — deliberately not the kind of hourly rewrite of a
 * TOASTed column that filled Neon in runbook #14.
 */
export async function recordHeartbeatSentAt(at: Date): Promise<void> {
  const value = JSON.stringify(at.toISOString());
  await sql`
    INSERT INTO config (key, value)
    VALUES (${LAST_SENT_KEY}, ${value}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = ${value}::jsonb, updated_at = now()
  `.execute(db);
}
