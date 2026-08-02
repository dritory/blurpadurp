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
import { autopublish } from "./pipeline/autopublish.ts";
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
// still want). autopublish sits between compose and dispatch so a
// draft that comes due is published in time for the same tick's
// dispatch sweep to mail it, rather than waiting a further hour.
const STAGES: StageJob[] = [
  { stage: "ingest", run: ingest },
  { stage: "score", run: score },
  { stage: "compose", run: compose },
  { stage: "autopublish", run: autopublish },
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
  cron_dow: number | null;
  cron_hour: number | null;
}

// Is an anchored stage due? Anchored stages (mig 066) fire on a fixed
// UTC weekday at/after a fixed UTC hour, at most once that day.
//
// This replaces interval drift for compose. "604800s since last
// success" moved the draft day forward by the run duration plus up to
// an hour of tick granularity every week, and any manual trigger
// re-anchored it permanently — which is why drafts arrived on
// arbitrary days.
//
// No TICK_INTERVAL_MS lookahead here: firing an anchored stage early
// would land it on the wrong day, which is the whole thing we're
// fixing. Late-by-under-an-hour is fine, early-by-a-day is not.
export function anchoredStageDue(
  s: Pick<StageState, "cron_dow" | "cron_hour" | "last_success_at">,
  now: Date,
): boolean {
  if (s.cron_dow === null || s.cron_hour === null) return false;
  if (now.getUTCDay() !== s.cron_dow) return false;
  if (now.getUTCHours() < s.cron_hour) return false;
  // Already ran today? Compare UTC calendar dates rather than a 24h
  // window, so a run at 06:05 doesn't leave the stage eligible again
  // at 06:00 sharp the following week.
  const last = s.last_success_at;
  if (last === null) return true;
  return last.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10);
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
    cron_dow: number | null;
    cron_hour: number | null;
  }>`
    SELECT
      s.stage,
      s.interval_sec,
      s.enabled,
      s.cron_dow,
      s.cron_hour,
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

// Next UTC datetime an anchored stage will fire. The display-side twin
// of anchoredStageDue — kept in this file so the two can't drift apart.
// Used by /admin/scheduler, which would otherwise project "last success
// + interval_sec" and print a date the scheduler will never act on.
export function nextAnchoredRun(
  dow: number,
  hour: number,
  lastSuccessAt: Date | null,
  now: Date,
): Date {
  const ranToday =
    lastSuccessAt !== null &&
    lastSuccessAt.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);

  const candidate = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hour,
      0,
      0,
      0,
    ),
  );
  // Today is the next slot only on the right weekday and only if the
  // stage hasn't already taken its turn — whether the hour has arrived
  // (due now) or is still ahead.
  if (now.getUTCDay() === dow && !ranToday) return candidate;

  let daysAhead = (dow - now.getUTCDay() + 7) % 7;
  // Same weekday, but today is spoken for → it's a week out.
  if (daysAhead === 0) daysAhead = 7;
  candidate.setUTCDate(candidate.getUTCDate() + daysAhead);
  return candidate;
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
    // Anchored stages ignore interval_sec entirely — the calendar slot
    // is the schedule. Note this also means an anchored stage that has
    // never run does NOT fire immediately; it waits for its slot.
    if (s.cron_dow !== null && s.cron_hour !== null) {
      if (anchoredStageDue(s, new Date())) {
        ready.push({ job, forced: false });
      }
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

