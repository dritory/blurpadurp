import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { db } from "../../src/db/index.ts";
import {
  countConsecutiveFailures,
  LAST_SENT_KEY,
  loadHealthSnapshot,
  loadLastHeartbeatSentAt,
  recordHeartbeatSentAt,
} from "../../src/shared/pipeline-heartbeat.ts";

// The judgement in pipeline-health.ts is pure and unit-tested. What
// needs a real database is the part that decides *what happened*: the
// "attempts since the last success" streak, which is a correlated
// aggregate over pipeline_run and is the input the whole alerting
// rate-limit hangs off. Get that wrong and either every tick mails or
// none do.

const RUN = process.env.RUN_INTEGRATION === "1";

const HOUR = 3_600_000;

async function insertRun(
  stage: string,
  status: "success" | "error",
  minutesAgo: number,
): Promise<void> {
  await sql`
    INSERT INTO pipeline_run (stage, status, started_at, completed_at, error)
    VALUES (
      ${stage},
      ${status},
      now() - (${minutesAgo} || ' minutes')::interval,
      now() - (${minutesAgo} || ' minutes')::interval,
      ${status === "error" ? "boom" : null}
    )
  `.execute(db);
}

describe.skipIf(!RUN)("pipeline heartbeat (integration)", () => {
  const clear = async () => {
    await sql`TRUNCATE pipeline_run`.execute(db);
    await db.deleteFrom("config").where("key", "=", LAST_SENT_KEY).execute();
  };
  beforeEach(clear);
  afterEach(clear);

  describe("countConsecutiveFailures", () => {
    test("a stage that has never run has no failures", async () => {
      expect(await countConsecutiveFailures("ingest")).toBe(0);
    });

    test("counts errors since the last success", async () => {
      await insertRun("ingest", "success", 300);
      await insertRun("ingest", "error", 120);
      await insertRun("ingest", "error", 60);
      await insertRun("ingest", "error", 5);
      expect(await countConsecutiveFailures("ingest")).toBe(3);
    });

    test("a success resets the streak", async () => {
      await insertRun("ingest", "error", 300);
      await insertRun("ingest", "error", 240);
      await insertRun("ingest", "success", 120);
      expect(await countConsecutiveFailures("ingest")).toBe(0);
    });

    test("errors before the last success don't count", async () => {
      // Otherwise the alert interval would keep widening forever off
      // failures that were already resolved, and a fresh outage after a
      // long history would mail on the wrong cadence.
      await insertRun("ingest", "error", 500);
      await insertRun("ingest", "error", 480);
      await insertRun("ingest", "success", 300);
      await insertRun("ingest", "error", 60);
      expect(await countConsecutiveFailures("ingest")).toBe(1);
    });

    test("a stage that has never succeeded counts every failure", async () => {
      await insertRun("dispatch", "error", 200);
      await insertRun("dispatch", "error", 100);
      expect(await countConsecutiveFailures("dispatch")).toBe(2);
    });

    test("streaks are per stage, not global", async () => {
      await insertRun("ingest", "error", 60);
      await insertRun("score", "error", 60);
      await insertRun("score", "error", 30);
      expect(await countConsecutiveFailures("ingest")).toBe(1);
      expect(await countConsecutiveFailures("score")).toBe(2);
    });

    test("a still-running row is neither success nor failure", async () => {
      await insertRun("ingest", "error", 60);
      await sql`
        INSERT INTO pipeline_run (stage, status, started_at)
        VALUES ('ingest', 'running', now())
      `.execute(db);
      expect(await countConsecutiveFailures("ingest")).toBe(1);
    });
  });

  describe("loadHealthSnapshot", () => {
    test("covers every scheduled stage, including heartbeat itself", async () => {
      // heartbeat reporting on heartbeat is the point: a digest stage
      // that silently stopped running would otherwise be the one gap
      // the digest can't show.
      const snap = await loadHealthSnapshot();
      const stages = snap.stages.map((s) => s.stage);
      for (const stage of [
        "ingest",
        "score",
        "compose",
        "autopublish",
        "dispatch",
        "retention",
        "heartbeat",
      ]) {
        expect(stages).toContain(stage);
      }
    });

    test("reads cadence and the anchored flag off pipeline_schedule", async () => {
      const snap = await loadHealthSnapshot();
      const compose = snap.stages.find((s) => s.stage === "compose");
      // compose is calendar-anchored (mig 066) and ignores interval_sec.
      // Measuring it against that column would flag the weekly brief as
      // stalled every week.
      expect(compose?.anchored).toBe(true);
      const score = snap.stages.find((s) => s.stage === "score");
      expect(score?.anchored).toBe(false);
      expect(score?.intervalSec).toBeGreaterThan(0);
    });

    test("surfaces the last success, status and error per stage", async () => {
      await insertRun("ingest", "success", 600);
      await insertRun("ingest", "error", 30);
      const snap = await loadHealthSnapshot();
      const ingest = snap.stages.find((s) => s.stage === "ingest");
      expect(ingest?.lastStatus).toBe("error");
      expect(ingest?.lastError).toBe("boom");
      expect(ingest?.consecutiveFailures).toBe(1);
      expect(ingest?.lastSuccessAt).not.toBeNull();
      expect(ingest?.sinceSuccessSec).toBeGreaterThan(30 * 60 - 60);
    });

    test("a stalled stage is flagged, a fresh one is not", async () => {
      // score runs daily; 5 days without a success is past 3× cadence.
      await insertRun("score", "success", 5 * 24 * 60);
      await insertRun("dispatch", "success", 10);
      const snap = await loadHealthSnapshot();
      expect(snap.stages.find((s) => s.stage === "score")?.stalled).toBe(true);
      expect(snap.stages.find((s) => s.stage === "dispatch")?.stalled).toBe(
        false,
      );
    });

    test("reads a real database size", async () => {
      const snap = await loadHealthSnapshot();
      expect(snap.dbBytes).not.toBeNull();
      expect(snap.dbBytes ?? 0).toBeGreaterThan(0);
      // storage.db_budget_mb is set by mig 078.
      expect(snap.dbBudgetBytes).not.toBeNull();
    });
  });

  describe("the last-sent marker", () => {
    test("round-trips through the config table", async () => {
      expect(await loadLastHeartbeatSentAt()).toBeNull();
      const at = new Date(Date.now() - 3 * HOUR);
      await recordHeartbeatSentAt(at);
      const back = await loadLastHeartbeatSentAt();
      expect(back?.getTime()).toBe(at.getTime());
    });

    test("overwrites rather than accumulating rows", async () => {
      await recordHeartbeatSentAt(new Date(Date.now() - 2 * HOUR));
      const later = new Date();
      await recordHeartbeatSentAt(later);

      const rows = await db
        .selectFrom("config")
        .select("key")
        .where("key", "=", LAST_SENT_KEY)
        .execute();
      expect(rows).toHaveLength(1);
      expect((await loadLastHeartbeatSentAt())?.getTime()).toBe(later.getTime());
    });

    test("a garbage value reads as null rather than throwing", async () => {
      // Someone editing it at /admin/config must not be able to wedge
      // the heartbeat — a null just means "send now".
      await sql`
        INSERT INTO config (key, value) VALUES (${LAST_SENT_KEY}, '"not a date"'::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = '"not a date"'::jsonb
      `.execute(db);
      expect(await loadLastHeartbeatSentAt()).toBeNull();
    });
  });
});
