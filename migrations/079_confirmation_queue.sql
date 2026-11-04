-- Queue confirmation emails the global send cap would otherwise drop.
--
-- POST /subscribe sends the confirmation inline, behind a process-wide
-- token bucket (60 burst, 1/min refill) that exists to bound outbound
-- mail from a distributed signup flood. The trouble is what happened
-- on a trip: the handler returned the normal "check your inbox"
-- redirect and silently dropped the send. For a flood that is right.
-- For a launch day it loses every real reader past the first sixty,
-- and the only trace is one operator alert.
--
-- So a tripped cap now QUEUES instead of dropping: the row is stamped
-- confirmation_queued_at and the dispatch stage drains the queue in
-- bounded batches (subscribe.confirmation_drain_batch per run, hourly
-- at most because the handler also queues a dispatch force-run). The
-- blast radius of a flood is therefore still bounded per hour, just by
-- the batch rather than the bucket, and a queued row older than
-- subscribe.confirmation_queue_max_age_hours is expired unsent — a
-- confirmation nobody asked for a day ago is spam, and retention
-- prunes the unconfirmed row later anyway.
--
-- Nullable, no backfill. Null = not waiting for a send. The partial
-- index keeps the drain's and the heartbeat's "anything queued?" read
-- to an index-only probe on a table that is almost always empty here.

ALTER TABLE email_subscription
  ADD COLUMN IF NOT EXISTS confirmation_queued_at timestamptz;

CREATE INDEX IF NOT EXISTS email_subscription_confirmation_queued_idx
  ON email_subscription (confirmation_queued_at)
  WHERE confirmation_queued_at IS NOT NULL;

INSERT INTO config (key, value) VALUES
  -- Sends per drain run. With a dispatch run an hour during a flood
  -- this is the real outbound ceiling (~4800/day), a step up from the
  -- bucket's ~1440/day sustained but now with nothing lost under it.
  ('subscribe.confirmation_drain_batch',          '200'::jsonb),
  -- Queued longer than this and the send is skipped, not made.
  ('subscribe.confirmation_queue_max_age_hours',  '24'::jsonb)
ON CONFLICT (key) DO NOTHING;
