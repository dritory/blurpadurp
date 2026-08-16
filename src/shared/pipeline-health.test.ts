import { describe, expect, test } from "bun:test";

import {
  ANCHORED_INTERVAL_SEC,
  assessStage,
  findProblems,
  formatBytes,
  type HealthSnapshot,
  heartbeatDecision,
  heartbeatSubject,
  renderHeartbeatLines,
  shouldNotifyFailure,
  type StageFacts,
  STALL_MULTIPLE,
} from "./pipeline-health.ts";

const NOW = new Date("2026-08-16T12:00:00Z");
const HOUR = 3_600_000;

function facts(over: Partial<StageFacts> = {}): StageFacts {
  return {
    stage: "score",
    enabled: true,
    intervalSec: 3600,
    anchored: false,
    lastSuccessAt: new Date(NOW.getTime() - HOUR),
    lastStatus: "success",
    lastError: null,
    consecutiveFailures: 0,
    failingSince: null,
    ...over,
  };
}

function snapshot(over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    now: NOW,
    stages: [assessStage(facts(), NOW)],
    draft: null,
    unscoredBacklog: 0,
    todaySpendUsd: 0,
    dailyCapUsd: 10,
    dbBytes: 100 * 1024 * 1024,
    dbBudgetBytes: 400 * 1024 * 1024,
    ...over,
  };
}

describe("assessStage", () => {
  test("a stage inside its cadence is healthy", () => {
    const s = assessStage(facts(), NOW);
    expect(s.stalled).toBe(false);
    expect(s.failing).toBe(false);
    expect(s.sinceSuccessSec).toBe(3600);
  });

  test("one missed cadence is not a stall — the machine is hourly", () => {
    // The scheduler machine is scale-to-zero on an hourly tick, so a
    // single skipped run is ordinary. Alerting on it would train the
    // operator to ignore the alert.
    const s = assessStage(
      facts({ lastSuccessAt: new Date(NOW.getTime() - 2 * HOUR) }),
      NOW,
    );
    expect(s.stalled).toBe(false);
  });

  test("stalls past the grace multiple", () => {
    const justOver = 3600 * STALL_MULTIPLE + 60;
    const s = assessStage(
      facts({ lastSuccessAt: new Date(NOW.getTime() - justOver * 1000) }),
      NOW,
    );
    expect(s.stalled).toBe(true);
  });

  test("a disabled stage is an operator decision, not a fault", () => {
    const s = assessStage(
      facts({
        enabled: false,
        lastSuccessAt: new Date(NOW.getTime() - 400 * HOUR),
      }),
      NOW,
    );
    expect(s.stalled).toBe(false);
  });

  test("an anchored stage is measured weekly, not against interval_sec", () => {
    // compose ignores interval_sec entirely (mig 066) — measuring it
    // against the leftover value in that column would report the weekly
    // brief as stalled every single week.
    const sixDays = facts({
      anchored: true,
      intervalSec: 3600,
      lastSuccessAt: new Date(NOW.getTime() - 6 * 24 * HOUR),
    });
    expect(assessStage(sixDays, NOW).stalled).toBe(false);

    const tooLong = facts({
      anchored: true,
      intervalSec: 3600,
      lastSuccessAt: new Date(
        NOW.getTime() - (ANCHORED_INTERVAL_SEC * STALL_MULTIPLE + 60) * 1000,
      ),
    });
    expect(assessStage(tooLong, NOW).stalled).toBe(true);
  });

  test("never succeeded is only a fault once it has tried and failed", () => {
    // On a fresh database every stage has no success yet; that's a new
    // install, not an incident.
    const fresh = facts({ lastSuccessAt: null, consecutiveFailures: 0 });
    expect(assessStage(fresh, NOW).stalled).toBe(false);

    const tried = facts({ lastSuccessAt: null, consecutiveFailures: 2 });
    expect(assessStage(tried, NOW).stalled).toBe(true);
  });
});

describe("shouldNotifyFailure", () => {
  test("mails on powers of two and nothing else", () => {
    const notified = [];
    for (let n = 1; n <= 64; n++) if (shouldNotifyFailure(n)) notified.push(n);
    expect(notified).toEqual([1, 2, 4, 8, 16, 32, 64]);
  });

  test("the first failure always mails", () => {
    expect(shouldNotifyFailure(1)).toBe(true);
  });

  test("a stage broken for a week sends ~8 mails, not 168", () => {
    let sent = 0;
    for (let n = 1; n <= 168; n++) if (shouldNotifyFailure(n)) sent++;
    expect(sent).toBe(8);
  });

  test("zero or negative never mails", () => {
    expect(shouldNotifyFailure(0)).toBe(false);
    expect(shouldNotifyFailure(-1)).toBe(false);
  });
});

describe("findProblems", () => {
  test("a healthy snapshot has none — that's what all-clear means", () => {
    expect(findProblems(snapshot())).toEqual([]);
  });

  test("reports a stalled stage with its last error", () => {
    const stalled = assessStage(
      facts({
        stage: "ingest",
        lastSuccessAt: new Date(NOW.getTime() - 100 * HOUR),
        lastStatus: "error",
        lastError: "BigQuery: permission denied\n  at gdelt.ts:88",
        consecutiveFailures: 12,
      }),
      NOW,
    );
    const problems = findProblems(snapshot({ stages: [stalled] }));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe("stage_stalled");
    expect(problems[0]?.summary).toContain("ingest");
    // First line of the error only — the digest is read on a phone.
    expect(problems[0]?.summary).toContain("permission denied");
    expect(problems[0]?.summary).not.toContain("gdelt.ts");
  });

  test("a draft past the staleness ceiling is the loudest problem", () => {
    // The sweep deliberately refuses to send it, and that refusal is
    // permanent until a human acts — and compose is blocked meanwhile.
    const problems = findProblems(
      snapshot({
        draft: {
          issueId: 42,
          draftedAt: new Date(NOW.getTime() - 100 * HOUR),
          hold: false,
          publishAfterHours: 24,
          maxAgeHours: 72,
        },
        stages: [
          assessStage(facts({ consecutiveFailures: 1, lastStatus: "error" }), NOW),
        ],
      }),
    );
    expect(problems[0]?.kind).toBe("draft_stuck");
    expect(problems[0]?.summary).toContain("#42");
    expect(problems[0]?.summary).toContain("blocking compose");
  });

  test("a held draft is reported even when it is young", () => {
    const problems = findProblems(
      snapshot({
        draft: {
          issueId: 7,
          draftedAt: new Date(NOW.getTime() - 2 * HOUR),
          hold: true,
          publishAfterHours: 24,
          maxAgeHours: 72,
        },
      }),
    );
    expect(problems[0]?.kind).toBe("draft_stuck");
    expect(problems[0]?.summary).toContain("on hold");
  });

  test("an ordinary open draft inside its window is not a problem", () => {
    const problems = findProblems(
      snapshot({
        draft: {
          issueId: 8,
          draftedAt: new Date(NOW.getTime() - 3 * HOUR),
          hold: false,
          publishAfterHours: 24,
          maxAgeHours: 72,
        },
      }),
    );
    expect(problems).toEqual([]);
  });

  test("budget warns near the cap and escalates at it", () => {
    expect(findProblems(snapshot({ todaySpendUsd: 7.9 }))).toEqual([]);
    const near = findProblems(snapshot({ todaySpendUsd: 8.5 }));
    expect(near[0]?.kind).toBe("budget");
    expect(near[0]?.summary).toContain("85%");
    const over = findProblems(snapshot({ todaySpendUsd: 11 }));
    expect(over[0]?.summary).toContain("refusing to run");
  });

  test("storage warns before writes start failing", () => {
    // The failure this exists for looked like "publish crashes".
    const problems = findProblems(
      snapshot({ dbBytes: 340 * 1024 * 1024 }),
    );
    expect(problems[0]?.kind).toBe("storage");
    expect(problems[0]?.summary).toContain("85%");
    expect(problems[0]?.summary).toContain("branch history");
  });

  test("no cap or no size reading means no false alarm", () => {
    expect(
      findProblems(snapshot({ dailyCapUsd: null, todaySpendUsd: 999 })),
    ).toEqual([]);
    expect(findProblems(snapshot({ dbBytes: null }))).toEqual([]);
    expect(findProblems(snapshot({ dbBudgetBytes: null }))).toEqual([]);
  });
});

describe("heartbeatDecision", () => {
  const policy = { alertIntervalSec: 12 * 3600, allClearIntervalSec: 168 * 3600 };
  const problem = [{ kind: "budget" as const, summary: "spend is high" }];

  test("problems mail immediately when nothing was sent recently", () => {
    const d = heartbeatDecision(problem, null, NOW, policy);
    expect(d.send).toBe(true);
    expect(d.kind).toBe("alert");
  });

  test("problems do not re-mail inside the alert window", () => {
    const d = heartbeatDecision(
      problem,
      new Date(NOW.getTime() - 2 * HOUR),
      NOW,
      policy,
    );
    expect(d.send).toBe(false);
  });

  test("a persisting problem re-mails once the window passes", () => {
    const d = heartbeatDecision(
      problem,
      new Date(NOW.getTime() - 13 * HOUR),
      NOW,
      policy,
    );
    expect(d.send).toBe(true);
    expect(d.kind).toBe("alert");
  });

  test("healthy and recently mailed stays silent", () => {
    const d = heartbeatDecision([], new Date(NOW.getTime() - 24 * HOUR), NOW, policy);
    expect(d.send).toBe(false);
    expect(d.kind).toBe("none");
  });

  test("healthy but long silent sends an all-clear", () => {
    // Without this, an empty inbox means both "fine" and "the monitor
    // is dead", and the operator cannot tell which.
    const d = heartbeatDecision(
      [],
      new Date(NOW.getTime() - 200 * HOUR),
      NOW,
      policy,
    );
    expect(d.send).toBe(true);
    expect(d.kind).toBe("all-clear");
  });

  test("the very first run always says something", () => {
    const d = heartbeatDecision([], null, NOW, policy);
    expect(d.send).toBe(true);
    expect(d.kind).toBe("all-clear");
  });
});

describe("the digest reads like something a human would act on", () => {
  test("the subject leads with the verdict", () => {
    expect(heartbeatSubject({ send: true, kind: "all-clear", problems: [], reason: "" }))
      .toBe("Blurpadurp: pipeline healthy");

    const subject = heartbeatSubject({
      send: true,
      kind: "alert",
      problems: [
        { kind: "draft_stuck", summary: "draft #42 is 100h old — blocking compose" },
        { kind: "budget", summary: "spend is high" },
      ],
      reason: "",
    });
    expect(subject).toContain("draft #42 is 100h old");
    expect(subject).toContain("+1 more");
  });

  test("problems come before the stage table", () => {
    const snap = snapshot({
      draft: {
        issueId: 42,
        draftedAt: new Date(NOW.getTime() - 100 * HOUR),
        hold: false,
        publishAfterHours: 24,
        maxAgeHours: 72,
      },
    });
    const decision = heartbeatDecision(findProblems(snap), null, NOW, {
      alertIntervalSec: 1,
      allClearIntervalSec: 1,
    });
    const lines = renderHeartbeatLines(decision, snap);
    const firstProblem = lines.findIndex((l) => l.includes("#42"));
    const stageTable = lines.findIndex((l) => l.startsWith("Stages"));
    expect(firstProblem).toBeGreaterThanOrEqual(0);
    expect(firstProblem).toBeLessThan(stageTable);
  });

  test("an all-clear states it rather than rendering an empty list", () => {
    const snap = snapshot();
    const decision = heartbeatDecision([], null, NOW, {
      alertIntervalSec: 1,
      allClearIntervalSec: 1,
    });
    const lines = renderHeartbeatLines(decision, snap);
    expect(lines[0]).toContain("Nothing to report");
    expect(lines.join("\n")).toContain("No open draft.");
  });

  test("stage flags show what is wrong at a glance", () => {
    const snap = snapshot({
      stages: [
        assessStage(facts({ stage: "ingest" }), NOW),
        assessStage(
          facts({
            stage: "score",
            lastSuccessAt: new Date(NOW.getTime() - 100 * HOUR),
            consecutiveFailures: 5,
          }),
          NOW,
        ),
        assessStage(facts({ stage: "dispatch", enabled: false }), NOW),
      ],
    });
    const decision = heartbeatDecision(findProblems(snap), null, NOW, {
      alertIntervalSec: 1,
      allClearIntervalSec: 1,
    });
    const text = renderHeartbeatLines(decision, snap).join("\n");
    expect(text).toMatch(/score\s+\d+d ago\s+\[STALLED, 5 failed\]/);
    expect(text).toContain("disabled");
  });
});

describe("formatBytes", () => {
  test("reads at a glance", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(400 * 1024 * 1024)).toBe("400 MB");
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });
});
