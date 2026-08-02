// Pipeline stage: autopublish.
//
// Hourly sweep with two jobs, in order:
//
//   1. Auto-fix any open draft that hasn't been through the checker
//      yet, so the draft the operator opens is already glossed. Runs
//      on every open draft regardless of age — within an hour of
//      compose, not at the publish deadline.
//   2. Publish drafts whose auto-publish deadline has passed, provided
//      their check came back clean.
//
// WHY THIS EXISTS: runCompose bails while any is_draft row exists, so a
// single forgotten draft silently blocked every compose behind it —
// that's how three weeks of briefs went unpublished with no error
// anywhere. A draft that can't sit forever can't block forever.
//
// The publish gate is the checker: a draft still carrying un-glossed
// terms after its auto-fix passes is HELD and the operator notified,
// rather than mailed out. Email is irreversible (dispatch_log's unique
// constraint is at-most-once and there is no recall), so the asymmetry
// is deliberate — a late brief is recoverable, a bad one isn't.
//
// Held drafts stay held until a human clears the flag on /admin/review.
// The sweep never un-holds anything.

import { db } from "../db/index.ts";
import { autoFixDraft } from "../shared/auto-fix.ts";
import { notifyAdmin } from "../shared/admin-notify.ts";
import { getConfigBool, getConfigNumber } from "../shared/config-store.ts";
import { withLock } from "../shared/pipeline-lock.ts";
import { isCleanAutoFix } from "../shared/check-schema.ts";
import { PUBLIC_URL } from "../api/config.ts";
import { publishDraft } from "./draft.ts";

const DEFAULT_AUTO_PUBLISH_HOURS = 24;
// Ceiling, not a deadline: above this a draft is held instead of sent.
// Comfortably clear of the 24h deadline so an ordinary late sweep (a
// machine down for a day) still publishes normally.
const DEFAULT_AUTO_PUBLISH_MAX_AGE_HOURS = 72;

export async function autopublish(): Promise<void> {
  await withLock("autopublish", 15 * 60_000, runAutopublish);
}

async function runAutopublish(): Promise<void> {
  const drafts = await db
    .selectFrom("issue")
    .select(["id", "title", "drafted_at", "auto_fix_jsonb"])
    .where("is_draft", "=", true)
    .where("hold", "=", false)
    .orderBy("drafted_at", "asc")
    .execute();

  if (drafts.length === 0) {
    console.log("[autopublish] no open drafts");
    return;
  }

  const enabled = await getConfigBool("compose.auto_publish_enabled", true);
  const hours = await getConfigNumber(
    "compose.auto_publish_hours",
    DEFAULT_AUTO_PUBLISH_HOURS,
  );
  const deadlineMs = hours * 3600_000;
  const now = Date.now();

  const maxAgeMs =
    (await getConfigNumber(
      "compose.auto_publish_max_age_hours",
      DEFAULT_AUTO_PUBLISH_MAX_AGE_HOURS,
    )) * 3600_000;

  for (const draft of drafts) {
    // drafted_at is NULL only for pre-mig-066 rows that were already
    // published, which this query excludes — but treat NULL as
    // "unknown age, don't auto-publish" rather than as epoch-zero,
    // which would fire instantly on a row we know nothing about.
    const age =
      draft.drafted_at === null ? null : now - draft.drafted_at.getTime();
    const decision = autopublishDecision({
      ageMs: age,
      deadlineMs,
      maxAgeMs,
      enabled,
    });

    if (decision === "skip_no_timestamp") {
      console.log(`[autopublish] draft ${draft.id}: no drafted_at, skipping`);
      continue;
    }

    // STALENESS CEILING. A brief is a snapshot of its week. Past this
    // age its lead is wrong, its "this week" framing is false, and
    // publishing would also burn every story it holds
    // (published_to_reader) on prose nobody should read.
    //
    // Handled BEFORE the auto-fix pass so a draft we're about to park
    // doesn't spend a checker call and up to two composer calls first.
    if (decision === "hold_stale") {
      await holdDraft(draft.id, draft.title, {
        reason: "stale",
        ageDays: Math.floor((age as number) / (24 * 3600_000)),
        maxAgeHours: Math.round(maxAgeMs / 3600_000),
      });
      continue;
    }

    // Pass 1: fix. A draft with no auto_fix_jsonb has never been through
    // the loop — do it now, whatever its age, so the operator sees
    // glossed prose long before the deadline. Already-processed drafts
    // are left alone; re-running would burn a composer call per hour.
    let clean: boolean;
    if (draft.auto_fix_jsonb === null) {
      const result = await autoFixDraft(draft.id);
      clean = result.clean;
    } else {
      clean = isCleanAutoFix(draft.auto_fix_jsonb);
    }

    if (!enabled) continue;

    // Pass 2: publish, if the deadline has passed.
    if (decision !== "due") continue;

    if (!clean) {
      await holdDraft(draft.id, draft.title, { reason: "unclean" });
      continue;
    }

    const published = await publishDraft(draft.id);
    console.log(
      `[autopublish] draft ${draft.id}: ${published ? "published" : "publish failed (not a draft?)"}`,
    );
  }
}

// Everything the sweep can decide about a draft BEFORE spending a
// checker/composer call on it. Split out so the precedence is testable:
// the staleness ceiling must beat the publish deadline, not race it in
// statement order.
//
//   skip_no_timestamp — no drafted_at; age unknown, leave it alone
//   hold_stale        — past the ceiling; park it, never send
//   wait              — inside the deadline; nothing to do yet
//   due               — past the deadline; publish if the check is clean
export type AutopublishDecision =
  | "skip_no_timestamp"
  | "hold_stale"
  | "wait"
  | "due";

export function autopublishDecision(o: {
  ageMs: number | null;
  deadlineMs: number;
  maxAgeMs: number;
  enabled: boolean;
}): AutopublishDecision {
  if (o.ageMs === null) return "skip_no_timestamp";
  // Ceiling before deadline. With the intended config (maxAge > deadline)
  // the two orderings happen to agree, since a stale draft is always
  // past its deadline as well — but they diverge the moment someone
  // sets max_age_hours below auto_publish_hours, and this order is the
  // one that fails safe there: hold, don't send.
  if (o.enabled && o.ageMs > o.maxAgeMs) return "hold_stale";
  if (o.ageMs < o.deadlineMs) return "wait";
  return "due";
}

export type HoldReason =
  | { reason: "unclean" }
  | { reason: "stale"; ageDays: number; maxAgeHours: number };

// Park a draft and tell the operator — the cases where the hands-off
// path deliberately stops.
async function holdDraft(
  id: number,
  title: string | null,
  why: HoldReason,
): Promise<void> {
  await db
    .updateTable("issue")
    .set({ hold: true })
    .where("id", "=", id)
    .where("is_draft", "=", true)
    .execute();

  const url = `${PUBLIC_URL}/admin/review/${id}`;
  const name = title ?? `Draft #${id}`;

  const { subject, body } =
    why.reason === "stale"
      ? {
          subject: `Draft held: "${name}" is ${why.ageDays} days old`,
          body:
            `${name} is ${why.ageDays} days old, past the ` +
            `${why.maxAgeHours}h auto-publish ceiling, so it was NOT sent. ` +
            `A brief that stale would go out with the wrong lead and would ` +
            `also burn every story it holds.\n\n` +
            `Usually the right action is Discard — that returns its stories ` +
            `to the pool for the next issue. Publish it by hand only if you ` +
            `genuinely want it sent as-is; clearing the hold won't help, ` +
            `since the next sweep will hold it again for the same reason.`,
        }
      : {
          subject: `Draft held: "${name}" still has gloss findings`,
          body:
            `${name} reached its auto-publish deadline but the checker ` +
            `still reports un-glossed terms after its automatic fix ` +
            `passes.\n\nIt has NOT been sent. Review, fix, and publish (or ` +
            `clear the hold to let the next sweep take it).`,
        };

  console.log(`[autopublish] draft ${id}: held — ${why.reason}`);
  await notifyAdmin({
    subject,
    text: `${body}\n\n${url}\n`,
    html: `<p>${escapeHtml(body).replace(/\n\n/g, "</p><p>")}</p><p><a href="${url}">Open the draft</a></p>`,
    // One mail per draft, not one per hourly sweep.
    dedupeKey: `autopublish-hold-${id}`,
    cooldownMs: 24 * 3600_000,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
