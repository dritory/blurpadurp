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
  progress_done: number | null;
  progress_total: number | null;
}

// Minimum gap between progress writes per stage. Score with concurrency=4
// can finish a story every ~250ms; without throttling we'd hammer the DB
// with redundant updates that the operator would never see at a faster
// cadence anyway.
const PROGRESS_THROTTLE_MS = 1500;
const lastWriteAt = new Map<string, number>();

// Update the live `progress_done`/`progress_total` of the latest still-
// running pipeline_run row for `stage`. No-op if no such row exists
// (e.g. when a stage is invoked outside runWithBookkeeping, like a
// direct CLI call without scheduler bookkeeping). `force=true` bypasses
// the throttle — use it for "first" and "final" calls so the start
// and end states are always visible.
export async function reportProgress(
  stage: string,
  done: number,
  total: number,
  force = false,
): Promise<void> {
  const now = Date.now();
  if (!force) {
    const prev = lastWriteAt.get(stage);
    if (prev !== undefined && now - prev < PROGRESS_THROTTLE_MS) return;
  }
  lastWriteAt.set(stage, now);

  const row = await db
    .selectFrom("pipeline_run")
    .select("id")
    .where("stage", "=", stage)
    .where("status", "=", "running")
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  if (row === undefined) return;

  await db
    .updateTable("pipeline_run")
    .set({ progress_done: done, progress_total: total })
    .where("id", "=", row.id)
    .execute();
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
      "progress_done",
      "progress_total",
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
    progress_done: lastAttempt?.progress_done ?? null,
    progress_total: lastAttempt?.progress_total ?? null,
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
  if (s.progress_total !== null && s.progress_total > 0) {
    const pct = Math.round(((s.progress_done ?? 0) / s.progress_total) * 100);
    lines.push(`progress:     ${s.progress_done ?? 0}/${s.progress_total} (${pct}%)`);
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
