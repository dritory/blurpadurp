-- Hands-off gloss fixing: keep retrying, stop parking the brief.
--
-- mig 066 made the check->fix loop automatic but left two places where
-- it still needed a human:
--
-- 1. IT RAN ONCE, EVER. The sweep only auto-fixed a draft with no
--    auto_fix_jsonb, so a run that came back "exhausted" was the end of
--    it — the remaining 23 hours before the publish deadline were spent
--    doing nothing. And because a fix is a full recompose, the outcome
--    of any single run is partly luck. Retrying is the cheap fix: the
--    sweep now re-runs while the draft is dirty, up to a LIFETIME cap
--    per draft (auto_fix_max_attempts) so an unfixable draft can't spend
--    a composer call an hour forever. max_passes stays per-run.
--
-- 2. IT HELD THE BRIEF. A draft that reached its deadline still carrying
--    gloss findings was parked for a human. That is the right call for a
--    factual problem and the wrong one here: an un-glossed acronym is a
--    copy-edit nit, and the cost of holding is that the whole brief goes
--    out late (or not at all, until someone notices) over six missing
--    words. auto_publish_requires_clean makes the choice explicit, and
--    it now defaults to OFF: publish, and tell the operator what shipped
--    imperfect. The STALENESS ceiling hold (mig 068) is untouched — that
--    one is about the brief being wrong, not merely unpolished.
--
-- Set auto_publish_requires_clean back to true to restore mig 066's
-- behaviour.

INSERT INTO config (key, value) VALUES
  -- Lifetime recompose attempts per draft, across all sweeps. At one
  -- sweep an hour and a 24h publish deadline, 6 gives the loop most of
  -- the day to converge while capping the worst case at 6 composer
  -- calls for an issue that ships once a week.
  ('compose.auto_fix_max_attempts',      '6'::jsonb),
  -- false: a leftover gloss finding no longer blocks auto-publish.
  ('compose.auto_publish_requires_clean', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;
