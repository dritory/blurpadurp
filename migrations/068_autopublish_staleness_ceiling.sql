-- Auto-publish staleness ceiling.
--
-- mig 066 gave drafts a 24h auto-publish deadline with no upper bound,
-- so the sweep would publish a draft of ANY age once it was past the
-- deadline and its check was clean. That is wrong in every case, not
-- just the obvious one: a brief is a snapshot of its week, so a stale
-- one goes out with the wrong lead and a false "this week" framing —
-- and publishing also flips published_to_reader on every story it
-- holds, burning them on prose nobody should have read.
--
-- Above this age the sweep holds the draft and notifies instead. There
-- is no age at which shipping a stale brief beats holding it, so the
-- ceiling takes precedence over the deadline rather than racing it.
--
-- 72h is deliberately well clear of compose.auto_publish_hours (24) so
-- an ordinary late sweep — scheduler machine down for a day, a long
-- lock — still publishes normally. It only trips on a draft that has
-- genuinely been sitting.
--
-- This also makes deploying mig 066 safe when a forgotten draft is
-- already open: without the ceiling the first sweep after the migration
-- would mail it, and the operator has at most one tick to intervene.

INSERT INTO config (key, value) VALUES
  ('compose.auto_publish_max_age_hours', '72'::jsonb)
ON CONFLICT (key) DO NOTHING;
