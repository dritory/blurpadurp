// Per-stage run + lock status for ops. The `pipeline_run` table is
// the historical record (one row per attempt); `pipeline_lock` is
// the live "is this stage currently executing" signal. Combining the
// two answers "what's the scorer doing right now, and how did the
// last run end?" without scraping logs.
//
// Used by the `status` CLI subcommand. Shape mirrors what
// /admin/scheduler renders so the two stay readable side-by-side.

import { db } from "../db/index.ts";

export interface StageStatus {
  stage: string;
  running: boolean;
  lock_expires_at: Date | null;
  last_started_at: Date | null;
  last_status: string | null;
  last_completed_at: Date | null;
  last_duration_ms: number | null;
  last_error: string | null;
  last_triggered_by: string | null;
  last_success_at: Date | null;
}

export async function loadStageStatus(stage: string): Promise<StageStatus> {
  const lock = await db
    .selectFrom("pipeline_lock")
    .select("expires_at")
    .where("stage_name", "=", stage)
    .executeTakeFirst();
  const lockExpiresAt = lock?.expires_at ?? null;
  const running = lockExpiresAt !== null && lockExpiresAt.getTime() > Date.now();

  const lastAttempt = await db
    .selectFrom("pipeline_run")
    .select([
      "started_at",
      "status",
      "completed_at",
      "duration_ms",
      "error",
      "triggered_by",
    ])
    .where("stage", "=", stage)
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();

  const lastSuccess = await db
    .selectFrom("pipeline_run")
    .select("completed_at")
    .where("stage", "=", stage)
    .where("status", "=", "success")
    .orderBy("completed_at", "desc")
    .limit(1)
    .executeTakeFirst();

  return {
    stage,
    running,
    lock_expires_at: lockExpiresAt,
    last_started_at: lastAttempt?.started_at ?? null,
    last_status: lastAttempt?.status ?? null,
    last_completed_at: lastAttempt?.completed_at ?? null,
    last_duration_ms: lastAttempt?.duration_ms ?? null,
    last_error: lastAttempt?.error ?? null,
    last_triggered_by: lastAttempt?.triggered_by ?? null,
    last_success_at: lastSuccess?.completed_at ?? null,
  };
}

export async function loadAllStageStatuses(): Promise<StageStatus[]> {
  const rows = await db
    .selectFrom("pipeline_run")
    .select("stage")
    .distinct()
    .execute();
  const stages = rows.map((r) => r.stage).sort();
  return Promise.all(stages.map(loadStageStatus));
}

export function formatStageStatus(s: StageStatus): string {
  const lines: string[] = [];
  lines.push(`stage:        ${s.stage}`);
  lines.push(`running:      ${s.running ? "yes" : "no"}`);
  if (s.running && s.lock_expires_at !== null) {
    lines.push(`lock expires: ${s.lock_expires_at.toISOString()}`);
  }
  lines.push(
    `last attempt: ${s.last_started_at?.toISOString() ?? "(never)"} ` +
      `[${s.last_status ?? "—"}` +
      (s.last_triggered_by ? ` via ${s.last_triggered_by}` : "") +
      `]`,
  );
  if (s.last_completed_at !== null) {
    lines.push(`completed:    ${s.last_completed_at.toISOString()}`);
  }
  if (s.last_duration_ms !== null) {
    lines.push(`duration:     ${(s.last_duration_ms / 1000).toFixed(1)}s`);
  }
  if (s.last_success_at !== null) {
    lines.push(`last success: ${s.last_success_at.toISOString()}`);
  } else {
    lines.push(`last success: (none recorded)`);
  }
  if (s.last_error !== null && s.last_error.length > 0) {
    lines.push(`error:        ${s.last_error}`);
  }
  return lines.join("\n");
}
