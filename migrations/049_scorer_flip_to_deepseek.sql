-- Flip scoring from Anthropic Haiku to DeepSeek V3.2. This is the
-- migration that actually changes prod behavior; everything before
-- this (clients, repair, off-peak guard, error classification) was
-- machinery to make this flip safe.
--
-- Validation history (200-story replay, 2026-05-19):
--   DeepSeek: 199/200 parsed, composite Δ -2.33, 22% early-reject
--             flips, 65% confidence shifts. Direction of shift
--             (more skeptical) counters the existing overconfidence
--             problem. Sample-audited disagreements; net neutral or
--             improvement vs Haiku.
--   Gemini Flash-Lite: 121/200 parsed (40% 503s on free tier),
--             worse confidence calibration. Rejected.
--
-- Prerequisites BEFORE applying this migration in prod:
--   fly secrets set OPENAI_COMPAT_BASE_URL=https://api.deepseek.com \
--                   OPENAI_COMPAT_API_KEY=sk-...
--   (or whatever the equivalent is for your deploy target)
-- If the env vars are missing when the next scoring tick fires, the
-- batch will halt via classifyPermanentError → notifyScorerHalted.
-- Set the secrets, then redeploy.
--
-- max_tokens bumped 2000 → 8000 because DeepSeek's tool-call outputs
-- run 2-4x longer than Haiku's. Output tokens are only billed for
-- what's actually generated, so the higher cap doesn't raise cost —
-- it just removes the truncation cliff.
--
-- After this lands and one scoring run succeeds, activate the off-peak
-- guard separately to halve the bill:
--   UPDATE config SET value = 'true'::jsonb WHERE key = 'scorer.off_peak_only';
--
-- Rollback: UPDATE config SET value = ... for each of the three keys
-- below, restoring "anthropic" / "claude-haiku-4-5-20251001" / 2000.

UPDATE config SET value = '"openai_compat"'::jsonb
  WHERE key = 'scorer.client';

UPDATE config SET value = '"deepseek-chat"'::jsonb
  WHERE key = 'scorer.model_id';

UPDATE config SET value = '8000'::jsonb
  WHERE key = 'scorer.max_tokens';
