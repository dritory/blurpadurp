# Dispatch

How a persisted issue reaches a reader. Separate from composition —
dispatch runs on its own cadence and never generates content, only
delivers it.

## Guarantees

1. **At most once per (issue, subscription).** Enforced by the
   `dispatch_log` unique constraint.
2. **Never to an unconfirmed or unsubscribed address.** Enforced by the
   send-window query.
3. **Never an empty issue.** Compose never persists one; dispatch never
   invents one.
4. **Delivery window honors the subscriber's timezone.** Tolerance
   ±30 min around `delivery_time_local`.
5. **Silence is a feature across channels.** No issue → no email, no push.

## The hourly sweep

A single cron invocation (default: hourly, top of the hour) calls
`dispatch()`. The call is idempotent — safe to retry, safe to run
twice concurrently — because of guarantee 1.

```
for each undelivered (issue, subscription) pair:
  if issue.is_event_driven and subscription.urgent_override:
    try send (no window check)
  else if now within ±30 min of subscriber's delivery_time_local:
    try send
  else:
    skip

"try send":
  insert dispatch_log (issue_id, subscription_kind, subscription_id)
    on conflict do nothing
  if that insert affected 0 rows: skip (already sent or racing)
  call Resend (email) or web-push (push)
  if the API returns a permanent failure: update dispatch_log.status,
    flag subscription as bouncing (see below)
  if it returns a transient failure: update dispatch_log.status,
    leave the row so the next sweep can retry
```

The dispatch_log insert is the serialization point. A successful insert
is the "intent to send" receipt. Even if the provider call crashes
afterward, the row exists and the next run skips it — so we never
double-send, at the cost of occasionally failing to send if Resend
throws between the insert and the API call. Acceptable trade.

## Send-window query

For email (analogous for push):

```sql
SELECT i.id AS issue_id, e.id AS subscription_id
FROM issue i
CROSS JOIN email_subscription e
LEFT JOIN dispatch_log d
  ON d.issue_id = i.id
  AND d.subscription_kind = 'email'
  AND d.subscription_id = e.id
WHERE d.id IS NULL                             -- not yet sent
  AND e.confirmed_at IS NOT NULL               -- confirmed
  AND e.unsubscribed_at IS NULL                -- not unsubscribed
  AND i.published_at >= now() - interval '7 days'  -- not stale
  AND (
    (i.is_event_driven AND e.urgent_override)   -- urgent path
    OR within_window(e.delivery_time_local, e.timezone)  -- scheduled
  )
  -- optional: category-mute filter via issue→story_ids→category_id
```

`within_window()` is a helper that converts the subscriber's local time
into UTC, computes the absolute distance from now, and returns true if
within 30 min.

## Timezones

Subscribers store `delivery_time_local` + `timezone` (IANA, e.g.
`Europe/Oslo`). The window check happens in SQL using Postgres's
`timezone()` function:

```sql
SELECT (now() AT TIME ZONE e.timezone)::time AS local_now,
       e.delivery_time_local AS want
```

DST crossings are handled by Postgres. Subscribers that pick a timezone
we don't recognize get silently dropped to UTC — logged, not blocked.

## Event-driven issues

When `issue.is_event_driven = true` (triggered by `cli urgent`):

- Subscribers with `urgent_override = true` get it immediately on the
  next dispatch sweep, regardless of window.
- Subscribers with `urgent_override = false` get it at their next
  scheduled window — same as a normal issue.

`urgent_override` defaults to `false`. Reader opts in explicitly.

## Email failures

Resend returns structured errors. Classify:

| Error | Action |
|---|---|
| `invalid-recipient` / `bounced-hard` | Mark subscription `unsubscribed_at = now()` with `dispatch_log.status = 'bounce-hard'`. One-strike — no retries. |
| `bounced-soft` (mailbox full, deferred) | `dispatch_log.status = 'bounce-soft'`, leave subscription active. Retry on the next issue. Three consecutive soft bounces → treat as hard. |
| `spam-complaint` | Unsubscribe immediately. Log to `dispatch_log.status = 'complaint'`. Do not retry under any circumstance. |
| `rate-limited` / `network` | Transient. Update status, let the next sweep retry. |
| Unknown | `dispatch_log.status = 'error'` with the raw message. Investigate. |

Webhook endpoint needed: Resend can POST delivery events to a URL.
Scaffold as `/webhooks/resend` — same HMAC verification pattern as the
magic-link tokens, signed with `RESEND_WEBHOOK_SECRET`.

## Push failures

web-push surfaces per-subscription errors via HTTP status on the
endpoint. Map:

| Status | Action |
|---|---|
| `410 Gone` | Subscription endpoint is dead (user cleared browser data, uninstalled). Unsubscribe. |
| `404 Not Found` | Same as 410. |
| `413 Payload Too Large` | We sent a too-big body. Truncate on our side — not the subscriber's fault. |
| `429` / `5xx` | Transient. Retry on next sweep. |

Push subscriptions churn fast (users reset browsers); expect ~20%
attrition per year from 410/404 alone.

## Preference management

Each dispatched email carries two signed-token links in the footer:

- **Manage** → `/manage/<token>` where kind=`manage-email`. Opens a
  public page where the subscriber can set `delivery_time_local`,
  `timezone`, `urgent_override`, `category_mutes`. TTL 30 days; a new
  token is minted into each issue's footer so users always have a
  fresh one.
- **Unsubscribe** → `/unsubscribe/<token>` where kind=`unsubscribe-email`.
  TTL 1 year. One click, sets `unsubscribed_at = now()`.

No confirmation step on unsubscribe — single-click unsubscribe is
required by RFC 8058. The `List-Unsubscribe-Post: One-Click` header
makes it work from Gmail/Outlook UI without ever visiting the URL.

## Category mutes

`email_subscription.category_mutes` is `text[]`. The send query filters
out issues whose story set is *entirely* in muted categories:

```sql
-- per (issue, subscription) eligibility:
NOT EXISTS (
  SELECT 1 FROM unnest(i.story_ids) sid
  JOIN story s ON s.id = sid
  JOIN category c ON c.id = s.category_id
  WHERE c.slug NOT IN (SELECT unnest(e.category_mutes))
)  -- only fire if all stories are muted
```

If even one story in the issue is in an unmuted category, the issue
goes out. Blunt filter, deliberate — we don't personalize the brief's
content, only whether it arrives.

## Observability

Every attempt writes a `dispatch_log` row. Useful queries:

```sql
-- yesterday's send stats
SELECT status, count(*)
FROM dispatch_log
WHERE dispatched_at >= date_trunc('day', now()) - interval '1 day'
GROUP BY status;

-- addresses bouncing repeatedly
SELECT subscription_id, count(*)
FROM dispatch_log
WHERE subscription_kind = 'email' AND status LIKE 'bounce%'
GROUP BY subscription_id
HAVING count(*) >= 3;
```

## Out of scope for v0.1

- Rate-limiting sends to Resend (their free tier is 3k/month, we won't
  hit it with operator + friends for months).
- Batched sends (we loop one subscription at a time; fine under 1000
  subscribers).
- Retry budget per issue (if Resend is down for six hours, we just
  resume — the at-most-once guarantee protects the reader).
- Multi-region queue (single-node is enough).
- A/B-ing send times (per-user delivery time is already the knob).

## Readiness checklist

Before turning dispatch on:

- [ ] `RESEND_API_KEY` and `FROM_EMAIL` set; domain SPF+DKIM verified.
- [ ] VAPID keys generated, `VAPID_PUBLIC_KEY` exposed via a route so
      the browser can subscribe.
- [ ] `/webhooks/resend` implemented and registered in Resend.
- [ ] `/manage/<token>` page implemented.
- [ ] Manual send test against the operator's own email passes.
- [ ] Stage-2 deploy has at least one published issue to dispatch.
