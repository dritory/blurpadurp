// Pipeline stage: dispatch.
//
// For every confirmed, non-unsubscribed email subscriber × published
// issue in the last 7 days, send the issue once. The `dispatch_log`
// unique constraint on (issue_id, subscription_kind, subscription_id)
// is the at-most-once guarantee — if two sweeps race, one's insert
// loses and that sweep skips the pair.
//
// v0 skips the per-subscriber delivery window + category mutes + the
// event-driven/urgent-override split described in docs/dispatch.md —
// fine for operator + friends, added back once we have subscribers who
// need them.
//
// Push delivery is out of scope. Stubbed for later.

import { db } from "../db/index.ts";
import { getEnvOptional } from "../shared/env.ts";
import { sendMail } from "../shared/mailer.ts";
import { withLock } from "../shared/pipeline-lock.ts";
import { signToken } from "../shared/tokens.ts";
import { renderBriefEmail, renderDraftReviewEmail } from "../views/email.ts";

const RECENCY_WINDOW_MS = 7 * 24 * 3600 * 1000;

export async function dispatch(): Promise<void> {
  await withLock("dispatch", 15 * 60_000, async () => {
    // Draft-review pass first: reviewers should see the draft before
    // (or as soon as) the published brief might go out. The two passes
    // are independent — a draft send and a published send for the same
    // issue×subscriber are distinct dispatch_log rows (subscription_kind
    // 'draft' vs 'email'), so neither blocks the other.
    await runDraftDispatch();
    await runDispatch();
  });
}

// A reviewer subscription has no display name, so derive a friendly one
// from the email's local part for the preview banner + annotation
// attribution. Falls back to the full address if there's nothing usable.
function reviewerNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const cleaned = local.replace(/[._-]+/g, " ").trim();
  if (cleaned.length === 0) return email;
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

// Draft-review dispatch. For every open draft × confirmed reviewer with
// no prior 'draft' dispatch_log row, email a signed draft-preview link.
// At-most-once is the same insert-then-send trick as the published
// sweep, keyed on subscription_kind='draft'.
async function runDraftDispatch(): Promise<void> {
  const brandUrl =
    getEnvOptional("BLURPADURP_PUBLIC_URL") ?? "http://localhost:3000";

  const pairs = await db
    .selectFrom("issue as i")
    .innerJoin("email_subscription as e", (join) =>
      join.on((eb) => eb.lit(true)),
    )
    .select([
      "i.id as issue_id",
      "i.title as issue_title",
      "i.published_at as published_at",
      "e.id as subscription_id",
      "e.email as email",
    ])
    .where("i.is_draft", "=", true)
    .where("e.is_reviewer", "=", true)
    .where("e.confirmed_at", "is not", null)
    .where("e.unsubscribed_at", "is", null)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("dispatch_log as d")
            .select("d.id")
            .whereRef("d.issue_id", "=", "i.id")
            .where("d.subscription_kind", "=", "draft")
            .whereRef("d.subscription_id", "=", "e.id"),
        ),
      ),
    )
    .orderBy("i.id", "desc")
    .orderBy("e.id", "asc")
    .execute();

  if (pairs.length === 0) {
    console.log("[dispatch:draft] no draft reviews to send");
    return;
  }

  console.log(`[dispatch:draft] ${pairs.length} (draft × reviewer) pairs`);
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const p of pairs) {
    const issueId = Number(p.issue_id);
    const subId = Number(p.subscription_id);
    const tag = `draft i${issueId}→sub${subId}`;

    const claim = await db
      .insertInto("dispatch_log")
      .values({
        issue_id: issueId,
        subscription_kind: "draft",
        subscription_id: subId,
        status: "sending",
      })
      .onConflict((oc) =>
        oc
          .columns(["issue_id", "subscription_kind", "subscription_id"])
          .doNothing(),
      )
      .returning("id")
      .executeTakeFirst();

    if (claim === undefined) {
      skipped++;
      continue;
    }

    const reviewerName = reviewerNameFromEmail(p.email);
    const token = signToken({
      kind: "draft-preview",
      subscriptionId: issueId,
      reviewerName,
    });
    const previewUrl = `${brandUrl}/draft/${issueId}?token=${encodeURIComponent(token)}`;

    const mail = renderDraftReviewEmail({
      brandUrl,
      previewUrl,
      title: p.issue_title,
      date: new Date(p.published_at),
    });

    const res = await sendMail({
      to: p.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });

    if (res.ok) {
      await db
        .updateTable("dispatch_log")
        .set({
          status: res.noop === true ? "noop" : "sent",
          error: null,
          provider_message_id: res.id,
        })
        .where("id", "=", claim.id)
        .execute();
      sent++;
      console.log(
        `[dispatch:draft] ${tag} ${res.noop === true ? "noop" : "sent"} ${res.id ?? ""}`,
      );
    } else {
      const isTransient = res.bounceKind === "transient";
      await db
        .updateTable("dispatch_log")
        .set({
          status: isTransient ? "error_transient" : "error_permanent",
          error: res.error,
        })
        .where("id", "=", claim.id)
        .execute();
      failed++;
      console.error(
        `[dispatch:draft] ${tag} failed (${res.bounceKind}): ${res.error}`,
      );
    }
  }

  console.log(
    `[dispatch:draft] done · sent=${sent} skipped=${skipped} failed=${failed}`,
  );
}

async function runDispatch(): Promise<void> {
  const brandUrl =
    getEnvOptional("BLURPADURP_PUBLIC_URL") ?? "http://localhost:3000";
  const cutoff = new Date(Date.now() - RECENCY_WINDOW_MS);

  // All undelivered (issue, email subscription) pairs. CROSS JOIN with
  // a NOT EXISTS filter against dispatch_log — the planner will use
  // the UNIQUE index for fast lookup.
  const pairs = await db
    .selectFrom("issue as i")
    .innerJoin("email_subscription as e", (join) =>
      join.on((eb) => eb.lit(true)),
    )
    .select([
      "i.id as issue_id",
      "i.title as issue_title",
      "i.published_at as published_at",
      "i.is_event_driven as is_event_driven",
      "i.composed_html as composed_html",
      "i.composed_markdown as composed_markdown",
      "e.id as subscription_id",
      "e.email as email",
    ])
    .where("i.published_at", ">=", cutoff)
    .where("i.is_draft", "=", false)
    .where("e.confirmed_at", "is not", null)
    .where("e.unsubscribed_at", "is", null)
    // Only send issues published at or after the subscriber confirmed.
    // A new subscriber should see issues *going forward*, not the whole
    // 7-day backlog dumped in one blast. The public archive (/archive)
    // is how they catch up on what they missed.
    .whereRef("i.published_at", ">=", "e.confirmed_at")
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("dispatch_log as d")
            .select("d.id")
            .whereRef("d.issue_id", "=", "i.id")
            .where("d.subscription_kind", "=", "email")
            .whereRef("d.subscription_id", "=", "e.id"),
        ),
      ),
    )
    .orderBy("i.published_at", "desc")
    .orderBy("e.id", "asc")
    .execute();

  if (pairs.length === 0) {
    console.log("[dispatch] nothing to send");
    return;
  }

  console.log(`[dispatch] ${pairs.length} (issue × subscriber) pairs`);
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const p of pairs) {
    const issueId = Number(p.issue_id);
    const subId = Number(p.subscription_id);
    const tag = `i${issueId}→sub${subId}`;

    // Try-insert the intent row. Unique (issue, kind, sub) guards
    // against double-send; ON CONFLICT DO NOTHING + RETURNING id lets
    // us detect the race (another worker got there first).
    const claim = await db
      .insertInto("dispatch_log")
      .values({
        issue_id: issueId,
        subscription_kind: "email",
        subscription_id: subId,
        status: "sending",
      })
      .onConflict((oc) =>
        oc.columns(["issue_id", "subscription_kind", "subscription_id"]).doNothing(),
      )
      .returning("id")
      .executeTakeFirst();

    if (claim === undefined) {
      // Lost the race, or retrying a prior run. Either way: skip.
      skipped++;
      continue;
    }

    const unsubToken = signToken({
      kind: "unsubscribe-email",
      subscriptionId: subId,
    });
    const manageToken = signToken({
      kind: "manage-email",
      subscriptionId: subId,
    });
    const unsubscribeUrl = `${brandUrl}/unsubscribe/${unsubToken}`;
    const manageUrl = `${brandUrl}/manage/${manageToken}`;
    const issueUrl = `${brandUrl}/issue/${issueId}`;

    const mail = renderBriefEmail({
      brandUrl,
      issueUrl,
      unsubscribeUrl,
      manageUrl,
      title: p.issue_title,
      date: new Date(p.published_at),
      issueHtml: p.composed_html,
      issueMarkdown: p.composed_markdown,
    });

    const res = await sendMail({
      to: p.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      headers: {
        // RFC 8058 one-click unsubscribe. Gmail/Outlook offer a native
        // "Unsubscribe" button when these are present.
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });

    if (res.ok) {
      await db
        .updateTable("dispatch_log")
        .set({
          status: res.noop === true ? "noop" : "sent",
          error: null,
          provider_message_id: res.id,
        })
        .where("id", "=", claim.id)
        .execute();
      sent++;
      console.log(
        `[dispatch] ${tag} ${res.noop === true ? "noop" : "sent"} ${res.id ?? ""}`,
      );
    } else {
      const isTransient = res.bounceKind === "transient";
      await db
        .updateTable("dispatch_log")
        .set({
          status: isTransient ? "error_transient" : "error_permanent",
          error: res.error,
        })
        .where("id", "=", claim.id)
        .execute();
      // Transient errors: leave dispatch_log as errored; a future sweep
      // would re-attempt by looking for pairs without a log row. Since
      // our insert already claimed the row, we'd need explicit retry
      // logic. For v0 simplicity: transient errors are effectively
      // "try again after operator action" — log and move on.
      failed++;
      console.error(`[dispatch] ${tag} failed (${res.bounceKind}): ${res.error}`);
    }
  }

  console.log(
    `[dispatch] done · sent=${sent} skipped=${skipped} failed=${failed}`,
  );
}
