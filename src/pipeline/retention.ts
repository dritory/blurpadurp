// Data retention. GDPR Art. 5(1)(e) expects a defined storage
// limitation — we implement it here as three rules:
//
// 1. Unconfirmed subs older than 30 days → delete the row. They
//    never clicked the confirm link; no lawful basis to retain.
// 2. Unsubscribed subs older than 90 days → null out the email (keep
//    the row as a re-subscribe suppression marker). Email hash would
//    be nicer; not worth the extra dep for our scale. NULL-email rows
//    can still block a re-subscribe by id, though the /subscribe form
//    doesn't currently use that. Over time we can either delete the
//    rows entirely or move to a suppression-list table.
// 3. dispatch_log rows with status = 'noop' or 'delivered' older than
//    180 days → delete. Hard bounce / complaint rows we keep forever
//    (they're the reason we won't resend).
//
// Ai_call_log is left untouched — it's training-data substrate per
// CLAUDE.md's invariant ("Don't delete ai_call_log rows").

import { sql } from "kysely";
import { db } from "../db/index.ts";
import { withLock } from "../shared/pipeline-lock.ts";

const UNCONFIRMED_TTL_MS = 30 * 24 * 3600 * 1000;
const UNSUBSCRIBED_ANON_TTL_MS = 90 * 24 * 3600 * 1000;
const DISPATCH_LOG_TTL_MS = 180 * 24 * 3600 * 1000;

export async function retention(): Promise<void> {
  await withLock("retention", 5 * 60_000, runRetention);
}

async function runRetention(): Promise<void> {
  const now = Date.now();
  const unconfirmedCutoff = new Date(now - UNCONFIRMED_TTL_MS);
  const unsubscribedCutoff = new Date(now - UNSUBSCRIBED_ANON_TTL_MS);
  const dispatchCutoff = new Date(now - DISPATCH_LOG_TTL_MS);

  // 1. Delete unconfirmed rows past TTL.
  const unconfirmed = await db
    .deleteFrom("email_subscription")
    .where("confirmed_at", "is", null)
    .where("created_at", "<", unconfirmedCutoff)
    .executeTakeFirst();
  const unconfirmedDeleted = Number(unconfirmed.numDeletedRows ?? 0);

  // 2. Anonymize unsubscribed rows past TTL. Set email to a stable
  // null-equivalent so the UNIQUE index still works (Postgres treats
  // NULLs as distinct, so multiple NULLs coexist). Easier than adding
  // a separate suppression-list table.
  const unsubAnon = await db
    .updateTable("email_subscription")
    .set({
      email: sql<string>`'anonymized-' || id::text || '@removed.local'`,
    })
    .where("unsubscribed_at", "is not", null)
    .where("unsubscribed_at", "<", unsubscribedCutoff)
    .where("email", "not like", "anonymized-%@removed.local")
    .executeTakeFirst();
  const unsubAnonymized = Number(unsubAnon.numUpdatedRows ?? 0);

  // 3. Prune old successful dispatch_log rows. Keep bounce/complaint
  // rows indefinitely — they're the "don't try this address again"
  // trail and cost little.
  const dispatchPrune = await db
    .deleteFrom("dispatch_log")
    .where("status", "in", ["noop", "delivered", "sent"])
    .where("dispatched_at", "<", dispatchCutoff)
    .executeTakeFirst();
  const dispatchDeleted = Number(dispatchPrune.numDeletedRows ?? 0);

  console.log(
    `[retention] unconfirmed_deleted=${unconfirmedDeleted} unsub_anonymized=${unsubAnonymized} dispatch_pruned=${dispatchDeleted}`,
  );
}
