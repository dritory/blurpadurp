// Subscription + token + webhook routes (/subscribe, /confirm,
// /unsubscribe, /manage, /webhooks/resend). Extracted from index.tsx (#9).

import type { Hono, } from "hono";
import { z } from "zod";

import { db } from "../db/index.ts";
import { getEnvOptional } from "../shared/env.ts";
import { sendMail } from "../shared/mailer.ts";
import { notifyAdmin, renderAdminNotice } from "../shared/admin-notify.ts";
import {
  clientIp,
  makeRateLimiter,
  withinCooldown,
} from "../shared/rate-limit.ts";
import { verifySvixSignature } from "../shared/svix.ts";
import { signToken, verifyToken } from "../shared/tokens.ts";
import { renderConfirmationEmail } from "../views/email.ts";
import {
  ManagePage,
} from "../views/manage.tsx";
import { TokenResultPage } from "../views/token-result.tsx";
import {
  loadManageData,
  parseManageFlash,
  isValidTimezone,
} from "./loaders.tsx";
import { PUBLIC_URL } from "./config.ts";

// 5 attempts burst, refill at 1 per 30s (= 120/hour sustained). Plenty
// for a human; noisy for a script.
const subscribeLimiter = makeRateLimiter({
  capacity: 5,
  refillPerMs: 1 / 30_000,
});

// Per-recipient resend cooldown (mig 061). A human who lost the
// confirmation mail can re-request after this window; a bomber re-submitting
// the same victim address is capped to one mail per window.
const CONFIRMATION_COOLDOWN_MS = 15 * 60_000;

// Global confirmation-send cap (audit M1, distributed-IP abuse). The per-IP
// subscribeLimiter only throttles a single source; distinct IPs (a botnet)
// against distinct addresses still drives unbounded outbound mail on our
// sending domain. This token bucket is keyed on a fixed string so every
// accepted send draws from one shared budget: 60 burst, refill 1/min
// (~1440/day sustained) — generous for an organic signup spike, hard ceiling
// on abuse. In-memory/single-node by design (Cloudflare is the real DoS
// layer); the bucket persists across a sustained attack since the machine
// stays awake, and resets only on an idle restart. When it trips we drop the
// send silently (no enumeration signal) and alert the operator.
const CONFIRMATION_SEND_GLOBAL_KEY = "confirmation-send";
const confirmationSendLimiter = makeRateLimiter({
  capacity: 60,
  refillPerMs: 1 / 60_000,
});

export function registerSubscriptionRoutes(app: Hono): void {
const SubscribeSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

// Signed-token magic links. No login — the token IS the authorization.
// Scaffolded ahead of dispatch: once dispatch lands, the transactional
// emails will link here. Until then, links can be minted by hand via
// signToken() for testing.

app.get("/confirm/:token", async (c) => {
  const res = verifyToken(c.req.param("token"));
  if (!res.ok || res.payload.kind !== "confirm-email") {
    return c.html(<TokenResultPage title="Link invalid" body="That link is invalid or expired. Subscribe again from the homepage." error />, 400);
  }
  const row = await db
    .updateTable("email_subscription")
    .set({ confirmed_at: new Date() })
    .where("id", "=", res.payload.subscriptionId)
    .where("confirmed_at", "is", null)
    .returning("email")
    .executeTakeFirst();
  const msg = row
    ? `Confirmed — ${row.email}. You'll hear from Blurp when there's something worth reading.`
    : "Already confirmed. Nothing to do.";
  return c.html(<TokenResultPage title="Confirmed" body={msg} />);
});

app.get("/unsubscribe/:token", async (c) => {
  const res = verifyToken(c.req.param("token"));
  if (!res.ok || res.payload.kind !== "unsubscribe-email") {
    return c.html(<TokenResultPage title="Link invalid" body="That link is invalid or expired." error />, 400);
  }
  await db
    .updateTable("email_subscription")
    .set({ unsubscribed_at: new Date() })
    .where("id", "=", res.payload.subscriptionId)
    .where("unsubscribed_at", "is", null)
    .execute();
  return c.html(<TokenResultPage title="Unsubscribed" body="Unsubscribed. No more issues will be sent to this address." />);
});

// RFC 8058 one-click unsubscribe. Mail clients POST here when the user
// hits the native Unsubscribe button (set via the List-Unsubscribe-Post
// header in dispatch.ts).
app.post("/unsubscribe/:token", async (c) => {
  const res = verifyToken(c.req.param("token"));
  if (!res.ok || res.payload.kind !== "unsubscribe-email") {
    return c.text("invalid token", 400);
  }
  await db
    .updateTable("email_subscription")
    .set({ unsubscribed_at: new Date() })
    .where("id", "=", res.payload.subscriptionId)
    .where("unsubscribed_at", "is", null)
    .execute();
  return c.text("ok", 200);
});

app.get("/manage/:token", async (c) => {
  const v = verifyToken(c.req.param("token"));
  if (!v.ok || v.payload.kind !== "manage-email") {
    return c.html(
      <TokenResultPage
        title="Link invalid"
        body="That preferences link is invalid or expired. The next issue you receive will have a fresh one in the footer."
        error
      />,
      400,
    );
  }
  const data = await loadManageData(
    v.payload.subscriptionId,
    c.req.param("token"),
    parseManageFlash(c.req.query("saved"), c.req.query("error")),
  );
  if (data === null) return c.notFound();
  return c.html(<ManagePage data={data} />);
});

app.post("/manage/:token", async (c) => {
  const v = verifyToken(c.req.param("token"));
  if (!v.ok || v.payload.kind !== "manage-email") {
    return c.html(
      <TokenResultPage
        title="Link invalid"
        body="That preferences link is invalid or expired."
        error
      />,
      400,
    );
  }
  const token = c.req.param("token");
  const body = await c.req.parseBody({ all: true });

  // Unsubscribe shortcut.
  if (body.unsubscribe === "1") {
    await db
      .updateTable("email_subscription")
      .set({ unsubscribed_at: new Date() })
      .where("id", "=", v.payload.subscriptionId)
      .where("unsubscribed_at", "is", null)
      .execute();
    return c.html(
      <TokenResultPage
        title="Unsubscribed"
        body="Unsubscribed. No more issues will be sent to this address."
      />,
    );
  }

  const time = typeof body.delivery_time_local === "string"
    ? body.delivery_time_local.trim()
    : "";
  const tz = typeof body.timezone === "string" ? body.timezone.trim() : "";
  const urgent = body.urgent_override === "1";
  const muteRaw = body.mute;
  const mutes = Array.isArray(muteRaw)
    ? muteRaw.filter((v): v is string => typeof v === "string")
    : typeof muteRaw === "string"
      ? [muteRaw]
      : [];

  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(time)) {
    return c.redirect(`/manage/${token}?error=bad_time`, 303);
  }
  if (!isValidTimezone(tz)) {
    return c.redirect(`/manage/${token}?error=bad_tz`, 303);
  }

  // Normalize HH:MM -> HH:MM:00 so Postgres time parsing is happy.
  const normTime = time.length === 5 ? `${time}:00` : time;

  // Only accept category slugs that actually exist.
  const validSlugs = new Set(
    (await db.selectFrom("category").select("slug").execute()).map(
      (r) => r.slug,
    ),
  );
  const cleanMutes = Array.from(new Set(mutes.filter((m) => validSlugs.has(m))));

  await db
    .updateTable("email_subscription")
    .set({
      delivery_time_local: normTime,
      timezone: tz,
      urgent_override: urgent,
      category_mutes: cleanMutes,
    })
    .where("id", "=", v.payload.subscriptionId)
    .execute();

  return c.redirect(`/manage/${token}?saved=1`, 303);
});

app.post("/subscribe", async (c) => {
  const ip = clientIp(c.req.raw.headers, null);
  if (!subscribeLimiter.take(ip)) {
    return c.redirect("/subscribe?error=rate_limited", 303);
  }
  const body = await c.req.parseBody();
  // Honeypot: bots fill every field; humans leave this hidden one empty.
  // Silently redirect as if it succeeded — no signal to the bot.
  if (typeof body.company === "string" && body.company.length > 0) {
    return c.redirect("/subscribe?subscribed=1", 303);
  }
  const parsed = SubscribeSchema.safeParse({ email: body.email });
  if (!parsed.success) {
    return c.redirect("/subscribe?error=invalid_email", 303);
  }
  const email = parsed.data.email;

  // Upsert and get the row id back. ON CONFLICT DO NOTHING returns no
  // row when a conflict happens, so we follow with a SELECT for the
  // already-existing case.
  let row = await db
    .insertInto("email_subscription")
    .values({ email })
    .onConflict((oc) => oc.column("email").doNothing())
    .returning(["id", "confirmed_at", "last_confirmation_sent_at"])
    .executeTakeFirst();
  if (row === undefined) {
    row = await db
      .selectFrom("email_subscription")
      .where("email", "=", email)
      .select(["id", "confirmed_at", "last_confirmation_sent_at"])
      .executeTakeFirst();
  }
  if (row === undefined) {
    // Shouldn't happen — upsert failed and subsequent lookup also
    // empty. Treat as a validation failure rather than leak a 500.
    return c.redirect("/subscribe?error=invalid_email", 303);
  }

  if (row.confirmed_at !== null) {
    // Already confirmed — don't spam them with another confirmation.
    return c.redirect("/subscribe?subscribed=1&already=1", 303);
  }

  // Per-recipient cooldown (mig 061). Re-submitting an unconfirmed address
  // would otherwise re-send a confirmation every time, so a victim address
  // could be bombed. Inside the window we skip the send but return the same
  // subscribed=1 redirect — the response must never reveal whether the
  // address exists or was just throttled.
  if (withinCooldown(row.last_confirmation_sent_at, CONFIRMATION_COOLDOWN_MS)) {
    return c.redirect("/subscribe?subscribed=1", 303);
  }

  // Global outbound-confirmation cap. Bounds blast radius from distributed
  // IPs that the per-IP limiter can't see. On a trip we drop the send
  // silently (same redirect, no enumeration signal) and alert the operator
  // — a dedupe key keeps it to one mail per window instead of one per
  // dropped send.
  if (!confirmationSendLimiter.take(CONFIRMATION_SEND_GLOBAL_KEY)) {
    console.warn("[subscribe] global confirmation-send cap tripped; dropping");
    const notice = renderAdminNotice({
      heading: "Confirmation-email cap tripped",
      bodyLines: [
        "The global outbound-confirmation rate limit was hit, so new " +
          "confirmation emails are being dropped.",
        "This usually means a distributed signup flood. Check /admin and " +
          "the edge (Cloudflare) if this persists.",
      ],
    });
    await notifyAdmin({
      subject: "Blurpadurp: confirmation-email cap tripped",
      html: notice.html,
      text: notice.text,
      dedupeKey: "confirmation-send-cap",
      cooldownMs: 60 * 60_000,
    });
    return c.redirect("/subscribe?subscribed=1", 303);
  }

  // Mint a signed /confirm/:token magic link and send it. Failure to
  // send is logged but doesn't reveal itself to the user — we never
  // tell a submitter whether their address was deliverable (prevents
  // email-validity probing).
  const token = signToken({
    kind: "confirm-email",
    subscriptionId: Number(row.id),
  });
  const confirmUrl = `${PUBLIC_URL}/confirm/${token}`;
  const mail = renderConfirmationEmail({
    brandUrl: PUBLIC_URL,
    confirmUrl,
  });
  // Stamp the send time before awaiting the network call so concurrent
  // resubmits of the same address can't slip past the cooldown. We stamp
  // even on send failure: a bouncing/erroring address shouldn't be a
  // retry-spam loophole, and the operator-facing error is logged below.
  await db
    .updateTable("email_subscription")
    .set({ last_confirmation_sent_at: new Date() })
    .where("id", "=", Number(row.id))
    .execute();
  const res = await sendMail({
    to: email,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (!res.ok) {
    console.error(
      `[subscribe] confirmation send failed for ${email}: ${res.error}`,
    );
  }
  return c.redirect("/subscribe?subscribed=1", 303);
});

// Resend webhook endpoint. Register in the Resend dashboard as
// https://<host>/webhooks/resend with event types email.bounced,
// email.complained, email.delivered (optional). Set RESEND_WEBHOOK_SECRET
// to the `whsec_...` value Resend generates.
//
// Hard bounces and complaints auto-unsubscribe. Soft bounces and
// delivery notifications update dispatch_log only (for observability).
app.post("/webhooks/resend", async (c) => {
  const secret = getEnvOptional("RESEND_WEBHOOK_SECRET");
  if (secret === undefined || secret.length === 0) {
    console.error("[resend-webhook] RESEND_WEBHOOK_SECRET not set; rejecting");
    return c.text("webhook not configured", 503);
  }

  const rawBody = await c.req.text();
  const verify = verifySvixSignature({
    body: rawBody,
    svixId: c.req.header("svix-id") ?? "",
    svixTimestamp: c.req.header("svix-timestamp") ?? "",
    svixSignature: c.req.header("svix-signature") ?? "",
    secret,
  });
  if (!verify.ok) {
    console.warn(`[resend-webhook] rejected: ${verify.reason}`);
    return c.text("invalid signature", 401);
  }

  let event: {
    type?: string;
    data?: {
      email_id?: string;
      to?: string | string[];
      bounce?: { type?: string };
    };
  };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return c.text("bad payload", 400);
  }

  const kind = event.type ?? "";
  const data = event.data ?? {};
  const emailId = data.email_id ?? null;
  const recipients = Array.isArray(data.to)
    ? data.to
    : typeof data.to === "string"
      ? [data.to]
      : [];

  // Map event → dispatch_log status string. Keep vocabulary stable so
  // the admin costs/status pages can count categories.
  let status: string | null = null;
  let unsubscribe = false;
  if (kind === "email.delivered") {
    status = "delivered";
  } else if (kind === "email.bounced") {
    const bounceType = data.bounce?.type ?? "";
    if (/hard|undetermined/i.test(bounceType)) {
      status = "bounce_hard";
      unsubscribe = true;
    } else {
      status = "bounce_soft";
    }
  } else if (kind === "email.complained") {
    status = "complaint";
    unsubscribe = true;
  } else if (kind === "email.delivery_delayed") {
    status = "delayed";
  } else {
    // Unknown / uninteresting event — acknowledge, don't retry.
    console.log(`[resend-webhook] ignored event: ${kind}`);
    return c.text("ok", 200);
  }

  // Update dispatch_log row if we can match by provider_message_id.
  // Without a match the event is still useful — we can still
  // unsubscribe on hard bounce / complaint by email.
  if (emailId !== null && status !== null) {
    const updated = await db
      .updateTable("dispatch_log")
      .set({ status })
      .where("provider_message_id", "=", emailId)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) === 0) {
      console.log(
        `[resend-webhook] no dispatch_log match for provider_message_id=${emailId} (${kind})`,
      );
    }
  }

  if (unsubscribe && recipients.length > 0) {
    const res = await db
      .updateTable("email_subscription")
      .set({ unsubscribed_at: new Date() })
      .where("email", "in", recipients.map((r) => r.toLowerCase()))
      .where("unsubscribed_at", "is", null)
      .executeTakeFirst();
    console.log(
      `[resend-webhook] ${kind} → unsubscribed ${Number(res.numUpdatedRows ?? 0)} of ${recipients.length} recipient(s)`,
    );
  }

  return c.text("ok", 200);
});
}
