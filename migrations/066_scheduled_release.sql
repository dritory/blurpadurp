-- Scheduled release: fixed draft day, auto-publish, auto-gloss-fix.
--
-- Three related changes that together make the weekly release run
-- without an operator in the loop.
--
-- 1. FIXED DRAFT DAY. pipeline_schedule was interval-only, so compose
--    fired "604800s after the last success" — the day drifted by the
--    run duration plus up to an hour of tick granularity, and any
--    manual trigger re-anchored it permanently. Drafts landed on
--    arbitrary days. cron_dow + cron_hour give a calendar anchor;
--    both NULL keeps the old interval behaviour for other stages.
--
--    DOW follows Postgres EXTRACT(DOW) / JS getUTCDay(): 0=Sunday …
--    6=Saturday. Times are UTC — 06:00 UTC is 08:00 in Oslo summer.
--    Compose Saturday 06:00 UTC → auto-publish Sunday ~06:00 UTC →
--    dispatch sweep picks it up within 6h (mig 053).
--
-- 2. AUTO-PUBLISH. A draft left alone publishes itself after
--    compose.auto_publish_hours. This is also the structural fix for
--    the open-draft stall: runCompose bails while any is_draft row
--    exists, so one forgotten draft silently blocked every compose
--    behind it. A draft that can't sit forever can't block forever.
--
--    issue.drafted_at is a real column rather than reusing
--    published_at: publishDraft overwrites published_at (draft.ts),
--    so timing the auto-publish off it would let an edit or recompose
--    silently reset the draft's own clock.
--
-- 3. AUTO-GLOSS-FIX. The checker's propose→preview→accept loop
--    (mig 065) becomes automatic: up to auto_fix_max_passes
--    check→fix→re-check rounds at compose time, applied directly.
--    fix_candidate_jsonb stays for the manual path; the automatic
--    path records what it changed in auto_fix_jsonb so /admin/review
--    can still show before/after. Auto-apply, not un-auditable apply.
--
--    If the draft is still dirty after the last pass, it is HELD
--    (hold = true) and the operator is notified instead of it
--    shipping. Hands-off on a normal week, floor under a bad one.

ALTER TABLE pipeline_schedule
  ADD COLUMN cron_dow  smallint,
  ADD COLUMN cron_hour smallint;

ALTER TABLE pipeline_schedule
  ADD CONSTRAINT pipeline_schedule_cron_dow_range
    CHECK (cron_dow IS NULL OR (cron_dow BETWEEN 0 AND 6)),
  ADD CONSTRAINT pipeline_schedule_cron_hour_range
    CHECK (cron_hour IS NULL OR (cron_hour BETWEEN 0 AND 23)),
  -- Anchored scheduling needs both halves; one without the other is
  -- an operator slip, not a meaningful state.
  ADD CONSTRAINT pipeline_schedule_cron_pair
    CHECK ((cron_dow IS NULL) = (cron_hour IS NULL));

-- Saturday 06:00 UTC.
UPDATE pipeline_schedule
   SET cron_dow = 6, cron_hour = 6, updated_at = now()
 WHERE stage = 'compose';

-- Hourly sweep for drafts past their auto-publish deadline. Cheap:
-- one indexed lookup on a table with at most a handful of draft rows.
INSERT INTO pipeline_schedule (stage, interval_sec) VALUES
  ('autopublish', 3600)
ON CONFLICT (stage) DO NOTHING;

ALTER TABLE issue
  ADD COLUMN drafted_at    timestamptz,
  ADD COLUMN hold          boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_fix_jsonb jsonb;

-- Existing drafts: published_at was set at creation and not yet
-- overwritten (that only happens on publish), so it is the correct
-- drafted_at for exactly the rows that still need one. Historical
-- PUBLISHED rows keep drafted_at NULL rather than being backfilled with
-- a fabricated value — their real draft time wasn't recorded, and the
-- sweep only reads drafts anyway.
UPDATE issue SET drafted_at = published_at WHERE is_draft = true;

-- Default applied after the backfill so the ADD COLUMN above didn't
-- stamp every historical row with now(). New issues are created as
-- drafts, so this is their creation time.
ALTER TABLE issue ALTER COLUMN drafted_at SET DEFAULT now();

-- Partial index for the auto-publish sweep's only query: open,
-- un-held drafts ordered by age. Keeps a frequently-hit path off a
-- sequential scan per CLAUDE.md's Neon-CU guidance.
CREATE INDEX issue_autopublish_idx
  ON issue (drafted_at)
  WHERE is_draft = true AND hold = false;

INSERT INTO config (key, value) VALUES
  ('compose.auto_publish_enabled',  'true'::jsonb),
  ('compose.auto_publish_hours',    '24'::jsonb),
  ('compose.auto_fix_enabled',      'true'::jsonb),
  ('compose.auto_fix_max_passes',   '2'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- compose.min_publish_gap_hours (144) predates the calendar anchor and
-- is now a second source of truth for cadence. 144 < 168 so it cannot
-- block a weekly Saturday compose, but leaving it at a value that
-- looks like a cadence invites confusion. Demote it to a pure safety
-- rail: short enough never to fight the anchor, long enough to still
-- catch a double-fire within one day.
UPDATE config SET value = '20'::jsonb
 WHERE key = 'compose.min_publish_gap_hours';
