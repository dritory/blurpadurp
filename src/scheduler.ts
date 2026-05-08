// Cron-like in-app scheduler. One Fly machine, scheduled hourly,
// runs `bun run cli scheduler-tick`. Each tick consults
// pipeline_schedule for cadence + enabled flag and pipeline_run for
// last success, then fires whatever is due.
//
// Manual triggers from /admin/run/:stage call runWithBookkeeping
// directly — same pipeline_run accounting, marked triggered_by =
// 'manual'. Each stage's existing withLock (mig 024) catches re-entry
// when manual + cron collide; the second caller no-ops.
//
// Schedule lives in DB (mig 039) so cadence changes don't require a
// redeploy. Operator edits via /admin/scheduler.

import { sql } from "kysely";
import { db } from "./db/index.ts";
import { ingest } from "./pipeline/ingest.ts";
import { score } from "./pipeline/score.ts";
import { compose } from "./pipeline/compose.ts";
import { dispatch } from "./pipeline/dispatch.ts";
import { retention } from "./pipeline/retention.ts";

// The Fly machine schedule. Used as the lookahead window in the
// cooldown check: a stage whose due-time would fall before the next
// tick fires now, instead of waiting another full tick. Without this
// rounding, a stage that's due 2 minutes after a tick gets skipped
// and waits ~58 minutes to fire — visible as "dispatch ran late".
const TICK_INTERVAL_MS = 60 * 60_000;

export interface StageJob {
  stage: string;
  run: () => Promise<void>;
}

// Order matters within a single tick: ingest first (downstream sees
// fresh data), retention last (don't prune rows another stage may
// still want).
const STAGES: StageJob[] = [
  { stage: "ingest", run: ingest },
  { stage: "score", run: score },
  { stage: "compose", run: compose },
  { stage: "dispatch", run: dispatch },
  { stage: "retention", run: retention },
];

export function getStage(name: string): StageJob | undefined {
  return STAGES.find((s) => s.stage === name);
}

export function listStages(): readonly StageJob[] {
  return STAGES;
}

export type TriggerSource = "cron" | "manual" | "deploy";

export async function runTick(): Promise<void> {
  const schedule = await loadSchedule();
  const forced = await loadForceRun();
  console.log(
    `[scheduler] tick @ ${new Date().toISOString()} — ${schedule.size} configured, ${forced.size} forced`,
  );
  for (const job of STAGES) {
    const cfg = schedule.get(job.stage);
    if (cfg === undefined) {
      console.log(`[scheduler] ${job.stage}: no schedule row, skipping`);
      continue;
    }
    if (!cfg.enabled) {
      console.log(`[scheduler] ${job.stage}: disabled, skipping`);
      continue;
    }
    const isForced = forced.has(job.stage);
    if (!isForced) {
      const lastSuccess = await loadLastSuccess(job.stage);
      if (lastSuccess !== null) {
        const dueAt = lastSuccess.getTime() + cfg.interval_sec * 1000;
        // Fire if due before the next scheduled tick. Without this
        // rounding, a stage whose dueAt falls a few minutes after this
        // tick would skip and wait ~one full tick interval to fire.
        if (dueAt > Date.now() + TICK_INTERVAL_MS) {
          const minsUntil = Math.ceil((dueAt - Date.now()) / 60_000);
          console.log(
            `[scheduler] ${job.stage}: not due (next in ~${minsUntil}m)`,
          );
          continue;
        }
      }
    }
    // Delete the force-run row before firing so a crash mid-run does
    // not auto-retry on the next tick. Operator re-queues by clicking
    // "Run now" again. Cron path is unaffected.
    if (isForced) {
      await db
        .deleteFrom("pipeline_force_run")
        .where("stage", "=", job.stage)
        .execute();
    }
    console.log(`[scheduler] ${job.stage}: firing (${isForced ? "manual" : "cron"})`);
    await runWithBookkeeping(job, isForced ? "manual" : "cron");
  }
  console.log(`[scheduler] tick done`);
}

// Wraps a stage call with pipeline_run accounting. Errors are logged
// but never rethrown — a single bad stage must not abort the rest of
// the tick.
export async function runWithBookkeeping(
  job: StageJob,
  triggeredBy: TriggerSource,
): Promise<void> {
  const t0 = Date.now();
  const inserted = await db
    .insertInto("pipeline_run")
    .values({
      stage: job.stage,
      status: "running",
      triggered_by: triggeredBy,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  try {
    await job.run();
    await db
      .updateTable("pipeline_run")
      .set({
        status: "success",
        completed_at: sql`now()`,
        duration_ms: Date.now() - t0,
      })
      .where("id", "=", inserted.id)
      .execute();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .updateTable("pipeline_run")
      .set({
        status: "error",
        completed_at: sql`now()`,
        duration_ms: Date.now() - t0,
        // 4000 chars is plenty for any message body; keeps the column
        // bounded against pathological stack traces.
        error: msg.slice(0, 4000),
      })
      .where("id", "=", inserted.id)
      .execute();
    console.error(`[scheduler] ${job.stage} errored:`, msg);
  }
}

interface ScheduleRow {
  interval_sec: number;
  enabled: boolean;
}

async function loadSchedule(): Promise<Map<string, ScheduleRow>> {
  const rows = await db
    .selectFrom("pipeline_schedule")
    .select(["stage", "interval_sec", "enabled"])
    .execute();
  return new Map(
    rows.map((r) => [
      r.stage,
      { interval_sec: r.interval_sec, enabled: r.enabled },
    ]),
  );
}

async function loadForceRun(): Promise<Set<string>> {
  const rows = await db
    .selectFrom("pipeline_force_run")
    .select("stage")
    .execute();
  return new Set(rows.map((r) => r.stage));
}

async function loadLastSuccess(stage: string): Promise<Date | null> {
  const row = await db
    .selectFrom("pipeline_run")
    .select("completed_at")
    .where("stage", "=", stage)
    .where("status", "=", "success")
    .orderBy("completed_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return row?.completed_at ?? null;
}
