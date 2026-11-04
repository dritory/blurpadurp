// Confirmation email: the one send that is NOT an issue.
//
// Two callers. POST /subscribe sends inline on an accepted signup, and
// the dispatch stage drains the rows the handler's global send cap
// deferred (mig 079). Both go through sendConfirmation so the token,
// the template and the bookkeeping on the row can't diverge.
//
// The bookkeeping is the point. last_confirmation_sent_at is stamped
// BEFORE the network call so a concurrent resubmit of the same address
// can't slip past the per-recipient cooldown, and it is stamped even
// when the send fails — a bouncing address must not become a retry
// loophole. confirmation_queued_at is cleared in the same write: a row
// that just got its mail is no longer waiting for one.

import { sql } from "kysely";

import { db } from "../db/index.ts";
import { getConfigNumber } from "./config-store.ts";
import { getEnvOptional } from "./env.ts";
import { type Locale, DEFAULT_LOCALE, isLocale } from "./i18n.ts";
import { sendMail } from "./mailer.ts";
import { signToken } from "./tokens.ts";
import { renderConfirmationEmail } from "../views/email.ts";

export interface ConfirmationTarget {
  id: number;
  email: string;
  locale: string | null;
}

function brandUrl(): string {
  return getEnvOptional("BLURPADURP_PUBLIC_URL") ?? "http://localhost:3000";
}

function subscriberLocale(value: string | null | undefined): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** Stamp the row, then mint a /confirm/:token link and mail it.
 *  Send failures are logged, never surfaced to the submitter — we never
 *  tell anyone whether an address was deliverable. */
export async function sendConfirmation(row: ConfirmationTarget): Promise<void> {
  await db
    .updateTable("email_subscription")
    .set({
      last_confirmation_sent_at: new Date(),
      confirmation_queued_at: null,
    })
    .where("id", "=", row.id)
    .execute();
  const token = signToken({ kind: "confirm-email", subscriptionId: row.id });
  const mail = renderConfirmationEmail({
    brandUrl: brandUrl(),
    confirmUrl: `${brandUrl()}/confirm/${token}`,
    locale: subscriberLocale(row.locale),
  });
  const res = await sendMail({
    to: row.email,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (!res.ok) {
    console.error(`[confirmation] send failed for ${row.email}: ${res.error}`);
  }
}

/** Park a row for the drain. COALESCE keeps the first queue time so a
 *  reader who resubmits while waiting keeps their place in line. */
export async function queueConfirmation(subscriptionId: number): Promise<void> {
  await db
    .updateTable("email_subscription")
    .set({
      confirmation_queued_at: sql`coalesce(confirmation_queued_at, now())`,
    })
    .where("id", "=", subscriptionId)
    .execute();
}

export interface DrainOptions {
  now?: Date;
  /** Rows sent per call. Defaults to subscribe.confirmation_drain_batch. */
  batch?: number;
  /** Queued longer than this → expired unsent. Defaults to
   *  subscribe.confirmation_queue_max_age_hours. */
  maxAgeMs?: number;
}

export interface DrainResult {
  sent: number;
  expired: number;
  /** Rows still queued after this run — nonzero means another run is due. */
  remaining: number;
}

/**
 * Send the oldest queued confirmations, at most `batch` of them, and
 * expire anything that has waited past `maxAgeMs`.
 *
 * The batch is the flood ceiling. A launch day queues a few hundred
 * real readers and drains in one or two runs; a botnet queues a few
 * hundred thousand and still only produces `batch` mails an hour, with
 * the rest expiring unsent after a day. Expiry happens first and is
 * not counted against the batch — it is a bookkeeping write, not a
 * send, and leaving expired rows in front of live ones would starve the
 * live ones.
 *
 * Rows that confirmed or unsubscribed while waiting are expired too:
 * a confirmed reader already clicked a link from an earlier mail, and
 * an unsubscribed one has said no.
 */
export async function drainConfirmationQueue(
  opts: DrainOptions = {},
): Promise<DrainResult> {
  const now = opts.now ?? new Date();
  const batch =
    opts.batch ??
    (await getConfigNumber("subscribe.confirmation_drain_batch", 200));
  const maxAgeMs =
    opts.maxAgeMs ??
    (await getConfigNumber("subscribe.confirmation_queue_max_age_hours", 24)) *
      3_600_000;
  const cutoff = new Date(now.getTime() - maxAgeMs);

  const expired = await db
    .updateTable("email_subscription")
    .set({ confirmation_queued_at: null })
    .where("confirmation_queued_at", "is not", null)
    .where((eb) =>
      eb.or([
        eb("confirmation_queued_at", "<", cutoff),
        eb("confirmed_at", "is not", null),
        eb("unsubscribed_at", "is not", null),
      ]),
    )
    .executeTakeFirst();

  const rows = await db
    .selectFrom("email_subscription")
    .select(["id", "email", "locale"])
    .where("confirmation_queued_at", "is not", null)
    .orderBy("confirmation_queued_at", "asc")
    .limit(batch)
    .execute();

  for (const r of rows) {
    await sendConfirmation({
      id: Number(r.id),
      email: r.email,
      locale: r.locale,
    });
  }

  const left = await db
    .selectFrom("email_subscription")
    .select(sql<string>`count(*)`.as("n"))
    .where("confirmation_queued_at", "is not", null)
    .executeTakeFirst();

  return {
    sent: rows.length,
    expired: Number(expired.numUpdatedRows ?? 0),
    remaining: Number(left?.n ?? 0),
  };
}

/** Depth and age of the queue, for the heartbeat. */
export async function loadConfirmationQueueFacts(): Promise<{
  depth: number;
  oldestQueuedAt: Date | null;
}> {
  const row = await db
    .selectFrom("email_subscription")
    .select([
      sql<string>`count(*)`.as("n"),
      sql<Date | null>`min(confirmation_queued_at)`.as("oldest"),
    ])
    .where("confirmation_queued_at", "is not", null)
    .executeTakeFirst();
  return {
    depth: Number(row?.n ?? 0),
    oldestQueuedAt: row?.oldest ? new Date(row.oldest) : null,
  };
}
