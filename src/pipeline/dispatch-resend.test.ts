import { describe, expect, test } from "bun:test";
import { DRAFT_SEND_SETTLED } from "./dispatch.ts";

// A manual draft re-send targets every reviewer whose dispatch_log
// status is NOT in DRAFT_SEND_SETTLED. That makes the classification of
// each status a correctness question: misfile a success and the
// reviewer gets a duplicate email; misfile a failure and a reviewer who
// never received the draft never gets it.
//
// This drifted once already. The list was written when only the
// dispatch stage wrote statuses; the Resend webhook
// (/webhooks/resend) later began rewriting them by
// provider_message_id, which the draft passes do store. 'sent' became
// 'delivered' on confirmation, fell outside the list, and the
// reviewers whose delivery was most certain were the ones re-targeted.
//
// So this pins the full vocabulary rather than just the list: a new
// status has to be classified here, which is the step that got skipped.

// Written by src/pipeline/dispatch.ts.
const DISPATCH_STATUSES = [
  "sending", // claimed, mail not yet returned — a run died mid-send
  "sent", // provider accepted it
  "noop", // mailer short-circuited (no provider configured)
  "error_transient",
  "error_permanent",
] as const;

// Written by the Resend webhook in src/api/subscription.tsx.
const WEBHOOK_STATUSES = [
  "delivered",
  "delayed", // still retrying at the provider
  "bounce_soft",
  "bounce_hard",
  "complaint",
] as const;

// Reviewers in these states already have the draft (or are about to) —
// re-sending would duplicate.
const EXPECT_SETTLED = ["sent", "noop", "delivered", "delayed"];

// Genuine non-delivery: a re-send is exactly the remedy.
const EXPECT_RETARGET = [
  "sending",
  "error_transient",
  "error_permanent",
  "bounce_soft",
  // bounce_hard / complaint reach this list too, but never matter in
  // practice: the webhook unsubscribes those addresses and the reviewer
  // query filters on unsubscribed_at IS NULL, so they're already gone.
  "bounce_hard",
  "complaint",
];

describe("DRAFT_SEND_SETTLED", () => {
  const settled = new Set<string>(DRAFT_SEND_SETTLED);

  test.each(EXPECT_SETTLED)("%s is settled — do not re-send", (status) => {
    expect(settled.has(status)).toBe(true);
  });

  test.each(EXPECT_RETARGET)("%s is not settled — re-send", (status) => {
    expect(settled.has(status)).toBe(false);
  });

  // The regression itself, called out by name so a future edit that
  // drops it fails with an obvious message.
  test("'delivered' is settled — the webhook rewrites 'sent' on confirmation", () => {
    expect(settled.has("delivered")).toBe(true);
  });

  // Forces classification of anything new. If this fails, add the
  // status to EXPECT_SETTLED or EXPECT_RETARGET above (and to
  // DRAFT_SEND_SETTLED if it means delivery succeeded).
  test("every known status is classified exactly once", () => {
    const known = [...DISPATCH_STATUSES, ...WEBHOOK_STATUSES].sort();
    const classified = [...EXPECT_SETTLED, ...EXPECT_RETARGET].sort();
    expect(classified).toEqual(known);
  });

  test("nothing in the settled list is unknown to the writers", () => {
    const known = new Set<string>([
      ...DISPATCH_STATUSES,
      ...WEBHOOK_STATUSES,
    ]);
    for (const s of DRAFT_SEND_SETTLED) expect(known.has(s)).toBe(true);
  });
});
