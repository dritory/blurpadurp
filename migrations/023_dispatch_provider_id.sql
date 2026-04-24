-- Store the provider's message id (Resend's `email_id`) on every
-- dispatch_log row that successfully shipped. Lets the webhook
-- handler link an incoming bounce/complaint event back to the exact
-- row and update its status.
--
-- Also: status column loosens implicitly — new values like 'bounce_hard',
-- 'bounce_soft', 'complaint' get written by the webhook handler. No
-- CHECK constraint on status, so no schema change needed for that.

ALTER TABLE dispatch_log
  ADD COLUMN IF NOT EXISTS provider_message_id text;

CREATE INDEX IF NOT EXISTS dispatch_log_provider_msg_idx
  ON dispatch_log(provider_message_id)
  WHERE provider_message_id IS NOT NULL;
