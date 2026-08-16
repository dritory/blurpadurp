// Heartbeat stage: mail the operator when the pipeline is stuck, and
// mail them occasionally when it isn't.
//
// This is the digest half of the observability pair. The other half is
// in the scheduler's error path, which fires the moment a stage throws
// (`shouldNotifyFailure`). They cover different failures: an exception
// is loud and immediate, whereas a stage that stops being *scheduled*,
// a draft parked past its staleness ceiling, or storage creeping toward
// the free-tier ceiling never throw anything. Nothing was watching those.
//
// Deliberately a normal pipeline stage rather than a bespoke cron: it
// gets the mutex, the `pipeline_run` bookkeeping, the /admin/scheduler
// row and the "Run now" button for free — and it shows up in its own
// digest, so a heartbeat that stops running is itself visible.

import { withLock } from "../shared/pipeline-lock.ts";
import { notifyAdmin, renderAdminNotice } from "../shared/admin-notify.ts";
import { getConfigNumber } from "../shared/config-store.ts";
import { getEnvOptional } from "../shared/env.ts";
import {
  findProblems,
  heartbeatDecision,
  heartbeatSubject,
  renderHeartbeatLines,
} from "../shared/pipeline-health.ts";
import {
  loadHealthSnapshot,
  loadLastHeartbeatSentAt,
  recordHeartbeatSentAt,
} from "../shared/pipeline-heartbeat.ts";

const LOCK_TTL_MS = 5 * 60_000;

export async function heartbeat(): Promise<void> {
  await withLock("heartbeat", LOCK_TTL_MS, async () => {
    const now = new Date();
    const snap = await loadHealthSnapshot(now);
    const problems = findProblems(snap);

    const [alertIntervalHours, allClearIntervalHours] = await Promise.all([
      getConfigNumber("heartbeat.alert_interval_hours", 12),
      getConfigNumber("heartbeat.all_clear_interval_hours", 168),
    ]);

    const decision = heartbeatDecision(
      problems,
      await loadLastHeartbeatSentAt(),
      now,
      {
        alertIntervalSec: alertIntervalHours * 3600,
        allClearIntervalSec: allClearIntervalHours * 3600,
      },
    );

    console.log(`[heartbeat] ${decision.reason}`);
    for (const p of decision.problems) {
      console.log(`[heartbeat] problem: ${p.summary}`);
    }
    if (!decision.send) return;

    const base = getEnvOptional("BLURPADURP_PUBLIC_URL");
    const { html, text } = renderAdminNotice({
      heading:
        decision.kind === "all-clear"
          ? "Pipeline healthy"
          : `Pipeline needs attention (${decision.problems.length})`,
      bodyLines: renderHeartbeatLines(decision, snap),
      ...(base !== undefined
        ? { ctaLabel: "Open admin status", ctaUrl: `${base}/admin/status` }
        : {}),
    });

    await notifyAdmin({ subject: heartbeatSubject(decision), html, text });

    // Only after the send. If the mail throws, the next run tries again
    // rather than recording a heartbeat nobody received. (notifyAdmin
    // swallows send failures, so this is belt-and-braces — but the
    // ordering is the part that should survive a future refactor.)
    await recordHeartbeatSentAt(now);
  });
}
