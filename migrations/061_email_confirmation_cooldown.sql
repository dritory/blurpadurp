-- Per-recipient confirmation-email cooldown (audit finding M1).
--
-- POST /subscribe sends a Resend confirmation to the submitted address on
-- every accepted, not-yet-confirmed submission. Re-submitting an
-- unconfirmed address therefore re-sends the email indefinitely, letting an
-- attacker bomb a victim's inbox using our sending domain. We record when a
-- confirmation was last sent so the handler can skip a resend inside a short
-- cooldown window while still returning the same anti-enumeration redirect.
--
-- Nullable, no backfill: existing unconfirmed rows simply have no recorded
-- send and are eligible for one immediate (re)send, which is correct.

ALTER TABLE email_subscription
  ADD COLUMN IF NOT EXISTS last_confirmation_sent_at timestamptz;
