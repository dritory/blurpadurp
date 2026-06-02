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

interface StageState {
  stage: string;
  interval_sec: number;
  enabled: boolean;
  forced: boolean;
  last_success_at: Date | null;
}

// One combined query for the full scheduler state — schedule rows,
// force-run flags, and most-recent success timestamp per stage. Cuts
// the per-tick query count from ~7 (loadSchedule + loadForceRun + one
// loadLastSuccess per stage) down to 1, so an empty tick wakes Neon
// for a single index lookup. The correlated subquery uses
// pipeline_run_stage_success_idx (mig 039); cost scales with the
// number of stages, not the size of pipeline_run.
async function loadState(): Promise<StageState[]> {
  const result = await sql<{
    stage: string;
    interval_sec: number;
    enabled: boolean;
    forced: boolean;
    last_success_at: Date | null;
  }>`
    SELECT
      s.stage,
      s.interval_sec,
      s.enabled,
      EXISTS (
        SELECT 1 FROM pipeline_force_run f WHERE f.stage = s.stage
      ) AS forced,
      (
        SELECT pr.completed_at
        FROM pipeline_run pr
        WHERE pr.stage = s.stage AND pr.status = 'success'
        ORDER BY pr.completed_at DESC
        LIMIT 1
      ) AS last_success_at
    FROM pipeline_schedule s
  `.execute(db);
  return result.rows;
}

export async function runTick(): Promise<void> {
  const state = await loadState();
  const byStage = new Map(state.map((r) => [r.stage, r]));

  // Decide everything from the single state snapshot before touching
  // the DB again. If nothing is due and nothing is forced, exit
  // without further queries — the DB then idle-suspends on Neon
  // within the timeout window.
  const ready: Array<{ job: StageJob; forced: boolean }> = [];
  for (const job of STAGES) {
    const s = byStage.get(job.stage);
    if (s === undefined) continue;
    if (!s.enabled) continue;
    if (s.forced) {
      ready.push({ job, forced: true });
      continue;
    }
    if (s.last_success_at === null) {
      ready.push({ job, forced: false });
      continue;
    }
    const dueAt = s.last_success_at.getTime() + s.interval_sec * 1000;
    if (dueAt <= Date.now() + TICK_INTERVAL_MS) {
      ready.push({ job, forced: false });
    }
  }

  if (ready.length === 0) {
    console.log(
      `[scheduler] tick @ ${new Date().toISOString()} — nothing due`,
    );
    return;
  }

  console.log(
    `[scheduler] tick @ ${new Date().toISOString()} — ${ready.length} stage(s) firing`,
  );
  for (const { job, forced } of ready) {
    // Delete the force-run row before firing so a crash mid-run does
    // not auto-retry on the next tick. Operator re-queues by clicking
    // "Run now" again. Cron path is unaffected.
    if (forced) {
      await db
        .deleteFrom("pipeline_force_run")
        .where("stage", "=", job.stage)
        .execute();
    }
    console.log(
      `[scheduler] ${job.stage}: firing (${forced ? "manual" : "cron"})`,
    );
    await runWithBookkeeping(job, forced ? "manual" : "cron");
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

