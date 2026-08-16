// Is the pipeline actually running, and if not, does anyone know?
//
// The scheduler already records every attempt in `pipeline_run` with a
// status and an error, and a stage that keeps failing stays due (it's
// `last_success_at` that gates the next fire, not `last_attempt_at`), so
// it retries hourly forever rather than silently advancing. That part
// was already right. What was missing is the human-facing half: the
// failure went to `console.error` on a machine that suspends, so a stage
// could fail every hour indefinitely and nothing would reach the
// operator.
//
// That matters more here than in most systems, because this product's
// correct output is sometimes *nothing*. A quiet week and a jammed
// pipeline look identical from the outside — which is exactly how one
// forgotten draft ate three weeks of briefs.
//
// Everything in this file is pure. The DB reads live in
// `pipeline-heartbeat.ts`, the send lives in `src/pipeline/heartbeat.ts`.

/** Assume weekly for an anchored stage (compose), which ignores interval_sec. */
export const ANCHORED_INTERVAL_SEC = 7 * 86_400;

/**
 * How many missed cadences before a stage counts as stalled. Three is
 * deliberately loose: the scheduler machine is hourly and scale-to-zero,
 * so one skipped tick is ordinary life, and an alert that fires on
 * ordinary life stops being read.
 */
export const STALL_MULTIPLE = 3;

export interface StageFacts {
  stage: string;
  enabled: boolean;
  /** Cadence from pipeline_schedule. Ignored when `anchored`. */
  intervalSec: number;
  /** Anchored stages (compose) fire on a calendar slot, not an interval. */
  anchored: boolean;
  lastSuccessAt: Date | null;
  lastStatus: string | null;
  lastError: string | null;
  /** Attempts since the last success. 0 when the last attempt succeeded. */
  consecutiveFailures: number;
  /** First attempt in the current failure streak, for "failing since". */
  failingSince: Date | null;
}

export interface StageHealth extends StageFacts {
  sinceSuccessSec: number | null;
  stalled: boolean;
  failing: boolean;
}

export function effectiveIntervalSec(facts: StageFacts): number {
  return facts.anchored ? ANCHORED_INTERVAL_SEC : facts.intervalSec;
}

export function assessStage(facts: StageFacts, now: Date): StageHealth {
  const sinceSuccessSec =
    facts.lastSuccessAt === null
      ? null
      : Math.max(0, Math.floor((now.getTime() - facts.lastSuccessAt.getTime()) / 1000));

  // A disabled stage is a deliberate operator choice, not a fault.
  const stalled =
    facts.enabled &&
    (sinceSuccessSec === null
      ? // Never succeeded. Only a fault once it has actually tried and
        // failed — on a fresh database every stage is here for one tick.
        facts.consecutiveFailures > 0
      : sinceSuccessSec > effectiveIntervalSec(facts) * STALL_MULTIPLE);

  return {
    ...facts,
    sinceSuccessSec,
    stalled,
    failing: facts.consecutiveFailures > 0,
  };
}

/**
 * Should the Nth consecutive failure of a stage send mail?
 *
 * Powers of two: 1, 2, 4, 8, 16… You hear about it immediately, then at
 * a decaying rate while it stays broken. A stage failing hourly for a
 * week sends 8 mails instead of 168, and — unlike a fixed cooldown —
 * this needs no stored state, which matters because the scheduler is a
 * fresh process every tick (`bun run cli scheduler-tick`) and any
 * in-memory dedup map is empty on arrival. `notifyAdmin`'s own dedup is
 * process-level for exactly that reason and cannot help here.
 */
export function shouldNotifyFailure(consecutiveFailures: number): boolean {
  if (consecutiveFailures < 1) return false;
  return (consecutiveFailures & (consecutiveFailures - 1)) === 0;
}

export interface DraftFacts {
  issueId: number;
  draftedAt: Date | null;
  hold: boolean;
  /** compose.auto_publish_hours */
  publishAfterHours: number;
  /** compose.auto_publish_max_age_hours — past this the sweep holds. */
  maxAgeHours: number;
}

export interface HealthSnapshot {
  now: Date;
  stages: StageHealth[];
  draft: DraftFacts | null;
  unscoredBacklog: number;
  todaySpendUsd: number;
  dailyCapUsd: number | null;
  dbBytes: number | null;
  dbBudgetBytes: number | null;
}

export type ProblemKind =
  | "stage_stalled"
  | "stage_failing"
  | "draft_stuck"
  | "budget"
  | "storage";

export interface Problem {
  kind: ProblemKind;
  /** One line, written to be read on a phone. */
  summary: string;
}

function hoursSince(then: Date, now: Date): number {
  return (now.getTime() - then.getTime()) / 3_600_000;
}

export function formatAge(seconds: number | null): string {
  if (seconds === null) return "never";
  if (seconds < 90) return `${Math.round(seconds)}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/**
 * Everything currently wrong, worst first. An empty list is the
 * all-clear — and is what makes the weekly heartbeat's "nothing to
 * report" a claim rather than an absence.
 */
export function findProblems(snap: HealthSnapshot): Problem[] {
  const problems: Problem[] = [];

  for (const s of snap.stages) {
    if (s.stalled) {
      problems.push({
        kind: "stage_stalled",
        summary:
          `${s.stage} has not succeeded since ${formatAge(s.sinceSuccessSec)}` +
          ` (cadence ${Math.round(effectiveIntervalSec(s) / 3600)}h)` +
          (s.lastError ? ` — last error: ${s.lastError.split("\n")[0]}` : ""),
      });
    } else if (s.failing) {
      // Failing but not yet stalled: the retries are still inside the
      // grace window. Worth reporting, not worth leading with.
      problems.push({
        kind: "stage_failing",
        summary:
          `${s.stage} has failed ${s.consecutiveFailures}× since its last success` +
          (s.lastError ? ` — ${s.lastError.split("\n")[0]}` : ""),
      });
    }
  }

  if (snap.draft !== null && snap.draft.draftedAt !== null) {
    const age = hoursSince(snap.draft.draftedAt, snap.now);
    if (snap.draft.hold) {
      problems.push({
        kind: "draft_stuck",
        summary:
          `draft #${snap.draft.issueId} is ${Math.round(age)}h old and on hold —` +
          ` it will not auto-publish, and compose is blocked while it exists`,
      });
    } else if (age > snap.draft.maxAgeHours) {
      // Past the staleness ceiling the sweep deliberately refuses to
      // send. Correct, and permanent until a human acts — so it is the
      // definition of something that needs saying out loud.
      problems.push({
        kind: "draft_stuck",
        summary:
          `draft #${snap.draft.issueId} is ${Math.round(age)}h old, past the ` +
          `${snap.draft.maxAgeHours}h staleness ceiling — held, not sent, and blocking compose`,
      });
    }
  }

  if (snap.dailyCapUsd !== null && snap.dailyCapUsd > 0) {
    const ratio = snap.todaySpendUsd / snap.dailyCapUsd;
    if (ratio >= 1) {
      problems.push({
        kind: "budget",
        summary: `today's AI spend $${snap.todaySpendUsd.toFixed(2)} has hit the $${snap.dailyCapUsd.toFixed(2)} cap — stages are refusing to run`,
      });
    } else if (ratio >= 0.8) {
      problems.push({
        kind: "budget",
        summary: `today's AI spend $${snap.todaySpendUsd.toFixed(2)} is ${Math.round(ratio * 100)}% of the $${snap.dailyCapUsd.toFixed(2)} cap`,
      });
    }
  }

  if (snap.dbBytes !== null && snap.dbBudgetBytes !== null && snap.dbBudgetBytes > 0) {
    const ratio = snap.dbBytes / snap.dbBudgetBytes;
    if (ratio >= 0.8) {
      // The autofix loop filled Neon once and it surfaced as "publish
      // crashes", because nothing was watching the number that was
      // actually moving.
      problems.push({
        kind: "storage",
        summary:
          `database is ${formatBytes(snap.dbBytes)} of a ${formatBytes(snap.dbBudgetBytes)} budget ` +
          `(${Math.round(ratio * 100)}%) — note Neon also counts branch history for the PITR window`,
      });
    }
  }

  const order: ProblemKind[] = [
    "draft_stuck",
    "stage_stalled",
    "storage",
    "budget",
    "stage_failing",
  ];
  return problems.sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind),
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

export interface HeartbeatDecision {
  send: boolean;
  kind: "alert" | "all-clear" | "none";
  problems: Problem[];
  reason: string;
}

export interface HeartbeatPolicy {
  /** Don't re-send an alert digest more often than this. */
  alertIntervalSec: number;
  /** Send an "everything is fine" digest at least this often. */
  allClearIntervalSec: number;
}

/**
 * Whether this heartbeat run should mail, given when one last did.
 *
 * Two rules, and the second is the one that's easy to skip:
 *
 *  1. Something is wrong → send, rate-limited to `alertIntervalSec`.
 *  2. Nothing is wrong → send anyway, if it's been longer than
 *     `allClearIntervalSec`.
 *
 * Without (2) the system can't distinguish "healthy" from "the monitor
 * is dead too" — silence would mean both. The all-clear is what makes
 * an empty inbox informative, and it's deliberately infrequent enough
 * (weekly, matching the publish cadence) not to become noise.
 */
export function heartbeatDecision(
  problems: Problem[],
  lastSentAt: Date | null,
  now: Date,
  policy: HeartbeatPolicy,
): HeartbeatDecision {
  const sinceSec =
    lastSentAt === null
      ? null
      : (now.getTime() - lastSentAt.getTime()) / 1000;

  if (problems.length > 0) {
    if (sinceSec !== null && sinceSec < policy.alertIntervalSec) {
      return {
        send: false,
        kind: "none",
        problems,
        reason: `${problems.length} problem(s), but mailed ${formatAge(sinceSec)} — inside the ${Math.round(policy.alertIntervalSec / 3600)}h alert window`,
      };
    }
    return {
      send: true,
      kind: "alert",
      problems,
      reason: `${problems.length} problem(s) found`,
    };
  }

  if (sinceSec === null || sinceSec >= policy.allClearIntervalSec) {
    return {
      send: true,
      kind: "all-clear",
      problems,
      reason:
        sinceSec === null
          ? "nothing wrong, and no heartbeat has ever been sent"
          : `nothing wrong, and the last heartbeat was ${formatAge(sinceSec)}`,
    };
  }

  return {
    send: false,
    kind: "none",
    problems,
    reason: `all clear, last heartbeat ${formatAge(sinceSec)}`,
  };
}

/** Subject line. Leads with the verdict — it may be all the operator reads. */
export function heartbeatSubject(decision: HeartbeatDecision): string {
  if (decision.kind === "all-clear") return "Blurpadurp: pipeline healthy";
  const lead = decision.problems[0];
  const rest = decision.problems.length - 1;
  const suffix = rest > 0 ? ` (+${rest} more)` : "";
  return `Blurpadurp: ${lead?.summary.split(" — ")[0] ?? "pipeline problem"}${suffix}`;
}

/**
 * The digest body. Problems first — an operator skimming on a phone
 * should not have to read a stage table to find out what's wrong — then
 * the full stage list as context for whatever they're about to do.
 */
export function renderHeartbeatLines(
  decision: HeartbeatDecision,
  snap: HealthSnapshot,
): string[] {
  const lines: string[] = [];

  if (decision.problems.length === 0) {
    lines.push("Nothing to report. Every stage is inside its cadence.");
  } else {
    for (const p of decision.problems) lines.push(`• ${p.summary}`);
  }

  lines.push("");
  lines.push("Stages (last success):");
  for (const s of snap.stages) {
    const flags = [
      s.enabled ? null : "disabled",
      s.stalled ? "STALLED" : null,
      s.failing ? `${s.consecutiveFailures} failed` : null,
    ].filter((f): f is string => f !== null);
    lines.push(
      `  ${s.stage.padEnd(12)} ${formatAge(s.sinceSuccessSec)}` +
        (flags.length > 0 ? `  [${flags.join(", ")}]` : ""),
    );
  }

  lines.push("");
  if (snap.draft !== null) {
    const age =
      snap.draft.draftedAt === null
        ? "unknown age"
        : `${Math.round(hoursSince(snap.draft.draftedAt, snap.now))}h old`;
    lines.push(
      `Open draft: #${snap.draft.issueId}, ${age}${snap.draft.hold ? ", on hold" : ""}.` +
        " compose is blocked while it exists.",
    );
  } else {
    lines.push("No open draft.");
  }
  lines.push(`Unscored backlog: ${snap.unscoredBacklog} stories.`);
  lines.push(
    `AI spend today: $${snap.todaySpendUsd.toFixed(2)}` +
      (snap.dailyCapUsd === null
        ? " (no cap set)"
        : ` of $${snap.dailyCapUsd.toFixed(2)}`),
  );
  if (snap.dbBytes !== null) {
    lines.push(
      `Database: ${formatBytes(snap.dbBytes)}` +
        (snap.dbBudgetBytes === null
          ? ""
          : ` of ${formatBytes(snap.dbBudgetBytes)}`),
    );
  }

  return lines;
}
