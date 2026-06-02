-- Reduce dispatch cadence from hourly to every 6h. Same rationale as
-- migration 052 for ingest: each sweep wakes Neon for ~5 min (idle
-- timeout), and an empty sweep still queries dispatch_log +
-- email_subscription. Hourly is overkill for a single-operator
-- weekly product.
--
-- The v0 dispatch in src/pipeline/dispatch.ts doesn't implement the
-- ±30 min delivery window described in docs/dispatch.md — it sends
-- to anyone with an unsent issue on the next sweep — so latency is
-- the only contract that changes. New subscribers wait up to 6h for
-- the next issue instead of up to 1h. Acceptable trade for free-tier
-- compute headroom; revisit when there are real subscribers with
-- real timezones.
--
-- Idempotent: only updates if the row is still at the original
-- hourly default. Operator overrides via /admin/scheduler survive.

UPDATE pipeline_schedule
SET interval_sec = 21600,
    updated_at = now()
WHERE stage = 'dispatch'
  AND interval_sec = 3600;
