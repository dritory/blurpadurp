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

  for (const draft of drafts) {
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
    //
    // drafted_at is NULL only for pre-mig-066 rows that were already
    // published, which this query excludes — but treat NULL as
    // "unknown age, don't auto-publish" rather than as epoch-zero,
    // which would fire instantly on a row we know nothing about.
    if (draft.drafted_at === null) {
      console.log(`[autopublish] draft ${draft.id}: no drafted_at, skipping`);
      continue;
    }
    const age = now - draft.drafted_at.getTime();
    if (age < deadlineMs) continue;

    if (!clean) {
      await holdDraft(draft.id, draft.title);
      continue;
    }

    const published = await publishDraft(draft.id);
    console.log(
      `[autopublish] draft ${draft.id}: ${published ? "published" : "publish failed (not a draft?)"}`,
    );
  }
}

// A draft that reached its deadline still failing its check. Park it and
// tell the operator — the one case where the hands-off path stops.
async function holdDraft(id: number, title: string | null): Promise<void> {
  await db
    .updateTable("issue")
    .set({ hold: true })
    .where("id", "=", id)
    .where("is_draft", "=", true)
    .execute();

  const url = `${PUBLIC_URL}/admin/review/${id}`;
  const name = title ?? `Draft #${id}`;
  console.log(`[autopublish] draft ${id}: held — check not clean`);
  await notifyAdmin({
    subject: `Draft held: "${name}" still has gloss findings`,
    text:
      `${name} reached its auto-publish deadline but the checker still ` +
      `reports un-glossed terms after its automatic fix passes.\n\n` +
      `It has NOT been sent. Review, fix, and publish (or clear the hold ` +
      `to let the next sweep take it):\n${url}\n`,
    html:
      `<p><strong>${escapeHtml(name)}</strong> reached its auto-publish ` +
      `deadline but the checker still reports un-glossed terms after its ` +
      `automatic fix passes.</p>` +
      `<p>It has <strong>not</strong> been sent. ` +
      `<a href="${url}">Review it</a> — fix and publish, or clear the hold ` +
      `to let the next sweep take it.</p>`,
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
