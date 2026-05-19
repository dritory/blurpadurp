-- Off-peak scheduling guard for the scorer. When true, the score stage
-- exits early outside DeepSeek's 50%-discount window (UTC 16:30 –
-- 00:30). The scheduler keeps ticking hourly; the run self-corrects
-- into the window within an hour of becoming due.
--
-- Why this exists: DeepSeek's off-peak pricing is a 50% cut on input +
-- output. For a daily batch scoring run at ~1300 stories, anchoring
-- the run to the discount window cuts the monthly bill in half with
-- no quality impact and no code complexity beyond this guard.
--
-- Default false so apply-time is a no-op on existing deployments
-- (e.g., Anthropic-only setups where there's no discount window).
-- Operators flip it via /admin/config or:
--   UPDATE config SET value = 'true'::jsonb
--   WHERE key = 'scorer.off_peak_only';
--
-- Window constants live in src/shared/off-peak.ts since they're tied
-- to a specific provider, not a tuning knob.

INSERT INTO config (key, value) VALUES
  ('scorer.off_peak_only', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;
