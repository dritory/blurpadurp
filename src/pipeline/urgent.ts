// Pipeline stage: urgent.
//
// Event-driven override, per docs/architecture.md: a single story scoring
// `composite >= event_driven_multiplier * gate.x_threshold` may publish
// mid-cycle as a one-item issue. Subscribers with `urgent_override = true`
// receive it immediately; others get it at their next scheduled window.
//
// STATUS: scaffolded, not wired into the hot path.
//
// This file computes the candidate set using existing columns but stops
// before composing — the composer prompt's user-message-template assumes
// a weekly bundle and would need a single-item template for urgent
// issues. Call it to see which stories WOULD trigger urgent publishing
// under the current thresholds.
//
// Next steps when this goes live:
//   1. Add a composer.prompt_version_urgent config + single-item prompt
//      template (separate from composer-prompt.md).
//   2. Set issue.is_event_driven = true on persist.
//   3. Trigger dispatch's urgent_override codepath.
//   4. Record published_to_reader on the story so it doesn't reappear
//      in the next weekly issue.

import { db } from "../db/index.ts";

interface Candidate {
  story_id: number;
  title: string;
  composite: number;
  threshold: number;
}

export async function urgent(): Promise<void> {
  const cfg = await loadThresholds();
  const minComposite = cfg.xThreshold * cfg.eventDrivenMultiplier;
  console.log(
    `[urgent] event-driven threshold: composite >= ${minComposite} ` +
      `(${cfg.xThreshold} × ${cfg.eventDrivenMultiplier})`,
  );

  const candidates = await findCandidates(minComposite);
  if (candidates.length === 0) {
    console.log("[urgent] no candidates clear the event-driven bar");
    return;
  }

  console.log(`[urgent] ${candidates.length} candidate(s):`);
  for (const c of candidates) {
    console.log(
      `  story ${c.story_id}  composite=${c.composite}  ${c.title.slice(0, 80)}`,
    );
  }
  console.log(
    "[urgent] compose/dispatch not implemented — see src/pipeline/urgent.ts",
  );
}

async function findCandidates(minComposite: number): Promise<Candidate[]> {
  const rows = await db
    .selectFrom("story")
    .select(["id", "title", "composite"])
    .where("passed_gate", "=", true)
    .where("published_to_reader", "=", false)
    .where("composite", ">=", String(minComposite))
    .where("point_in_time_confidence", "!=", "low")
    .orderBy("composite", "desc")
    .execute();
  return rows.map((r) => ({
    story_id: Number(r.id),
    title: r.title,
    composite: r.composite !== null ? Number(r.composite) : 0,
    threshold: minComposite,
  }));
}

async function loadThresholds(): Promise<{
  xThreshold: number;
  eventDrivenMultiplier: number;
}> {
  const rows = await db
    .selectFrom("config")
    .select(["key", "value"])
    .where("key", "in", ["gate.x_threshold", "gate.event_driven_multiplier"])
    .execute();
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const x = Number(map.get("gate.x_threshold") ?? 5);
  const m = Number(map.get("gate.event_driven_multiplier") ?? 2);
  return { xThreshold: x, eventDrivenMultiplier: m };
}
