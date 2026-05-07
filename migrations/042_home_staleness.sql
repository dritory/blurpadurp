-- Home-page staleness threshold. The `/` route shows the latest
-- published issue indefinitely today, so a quiet stretch (no new
-- brief for several weeks) leaves a stale issue dressed as the
-- current one — at odds with the product's "silence is a feature"
-- stance.
--
-- When `now() - latest.published_at` exceeds this many days, the home
-- page renders an explicit silence panel instead of the stale issue.
-- /archive and /feed.xml are unaffected — back issues remain at their
-- canonical URLs.
--
-- Default 8 days: weekly cadence (compose at interval 604800s) plus
-- one day of slack so a Sunday-late publish doesn't trip the cap on
-- Monday morning.
INSERT INTO config (key, value) VALUES
  ('home.staleness_threshold_days', '8'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
