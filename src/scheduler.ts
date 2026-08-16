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
import { compose, type RetroOptions } from "./pipeline/compose.ts";
import { autopublish } from "./pipeline/autopublish.ts";
import { dispatch } from "./pipeline/dispatch.ts";
import { retention } from "./pipeline/retention.ts";
import { heartbeat } from "./pipeline/heartbeat.ts";
import { notifyAdmin, renderAdminNotice } from "./shared/admin-notify.ts";
import { getEnvOptional } from "./shared/env.ts";
import { shouldNotifyFailure } from "./shared/pipeline-health.ts";
import { countConsecutiveFailures } from "./shared/pipeline-heartbeat.ts";

// The Fly machine schedule. Used as the lookahead window in the
// cooldown check: a stage whose due-time would fall before the next
// tick fires now, instead of waiting another full tick. Without this
// rounding, a stage that's due 2 minutes after a tick gets skipped
// and waits ~58 minutes to fire — visible as "dispatch ran late".
const TICK_INTERVAL_MS = 60 * 60_000;

export interface StageJob {
  stage: string;
  // `args` carries the jsonb payload from pipeline_force_run (mig 067)
  // for manually triggered runs, and is undefined on the cron path.
  // Stages that take no parameters simply ignore it.
  run: (args?: unknown) => Promise<void>;
}

// Order matters within a single tick: ingest first (downstream sees
// fresh data), retention last (don't prune rows another stage may
// still want). autopublish sits between compose and dispatch so a
// draft that comes due is published in time for the same tick's
// dispatch sweep to mail it, rather than waiting a further hour.
//
// heartbeat runs dead last, after retention, so its digest reports the
// state the tick actually left behind rather than the one it found.
const STAGES: StageJob[] = [
  { stage: "ingest", run: ingest },
  { stage: "score", run: score },
  { stage: "compose", run: (args) => compose(parseRetroArgs(args)) },
  { stage: "autopublish", run: autopublish },
  { stage: "dispatch", run: dispatch },
  { stage: "retention", run: retention },
  { stage: "heartbeat", run: heartbeat },
];

// Decode compose's force-run payload. Shape: {"retro": true} for a
// ranked catch-up run, or {"retro": {"storyIds": [1,2,3]}} for an
// operator-chosen set from /admin/release. Anything else means a normal
// run — a malformed payload must not silently become a catch-up.
export function parseRetroArgs(args: unknown): RetroOptions | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const retro = (args as { retro?: unknown }).retro;
  if (retro === true) return {};
  if (retro === null || typeof retro !== "object") return undefined;
  const ids = (retro as { storyIds?: unknown }).storyIds;
  if (!Array.isArray(ids)) return {};
  const storyIds = ids
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0);
  return { storyIds };
}

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
  // Payload of the pending force-run row, if any (mig 067).
  forced_args: unknown;
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
    forced_args: unknown;
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
        SELECT f.args FROM pipeline_force_run f WHERE f.stage = s.stage
      ) AS forced_args,
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
  const ready: Array<{ job: StageJob; forced: boolean; args?: unknown }> = [];
  for (const job of STAGES) {
    const s = byStage.get(job.stage);
    if (s === undefined) continue;
    if (!s.enabled) continue;
    if (s.forced) {
      ready.push({ job, forced: true, args: s.forced_args });
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
  for (const { job, forced, args } of ready) {
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
    await runWithBookkeeping(job, forced ? "manual" : "cron", args);
  }
  console.log(`[scheduler] tick done`);
}

// Wraps a stage call with pipeline_run accounting. Errors are logged
// but never rethrown — a single bad stage must not abort the rest of
// the tick.
export async function runWithBookkeeping(
  job: StageJob,
  triggeredBy: TriggerSource,
  args?: unknown,
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
    await job.run(args);
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
    await notifyStageFailure(job.stage, msg);
  }
}

// Tell the operator a stage threw.
//
// Until this existed the only record was the console.error above, on a
// machine that suspends between ticks — so a stage could fail every hour
// indefinitely and nothing would reach a human. The scheduler is correct
// about *retrying* (due-ness is computed from last_success_at, so a
// failing stage stays due rather than silently advancing); it was the
// telling-anyone half that was missing.
//
// Rate-limited by failure count, not by a clock: powers of two, so the
// first failure mails immediately and a stage broken for a week sends
// ~8 mails rather than 168. It has to be count-based because each tick
// is a fresh `bun run cli scheduler-tick` process — notifyAdmin's dedup
// map is in-memory and always empty on arrival.
//
// Never throws: an alert that breaks the tick it is reporting on would
// be worse than no alert.
async function notifyStageFailure(stage: string, message: string): Promise<void> {
  try {
    const failures = await countConsecutiveFailures(stage);
    if (!shouldNotifyFailure(failures)) {
      console.log(
        `[scheduler] ${stage}: failure #${failures} — suppressed (next mail at the following power of two)`,
      );
      return;
    }
    const base = getEnvOptional("BLURPADURP_PUBLIC_URL");
    const { html, text } = renderAdminNotice({
      heading: `${stage} failed`,
      bodyLines: [
        failures === 1
          ? `The ${stage} stage threw on its latest run.`
          : `The ${stage} stage has now failed ${failures}× in a row without a success in between.`,
        "",
        message.slice(0, 1000),
        "",
        "The scheduler keeps retrying: due-ness is computed from the last success, so a failing stage stays due rather than being skipped.",
      ],
      ...(base !== undefined
        ? { ctaLabel: "Open admin status", ctaUrl: `${base}/admin/status` }
        : {}),
    });
    await notifyAdmin({
      subject: `Blurpadurp: ${stage} failed${failures > 1 ? ` (${failures}× in a row)` : ""}`,
      html,
      text,
    });
  } catch (e) {
    console.error(
      `[scheduler] could not send failure notice for ${stage}:`,
      e instanceof Error ? e.message : e,
    );
  }
}

