-- Long-running themes: operator-curated flag for threads that deserve
-- weekly treatment regardless of current-pool size. Surfaced to the
-- editor so it can always include an update if there's new material,
-- and to the composer so it can anchor the write-up in the longer arc.
--
-- Defaults to false; operator toggles via /admin/themes.

ALTER TABLE theme
  ADD COLUMN is_long_running boolean NOT NULL DEFAULT false;

CREATE INDEX theme_is_long_running_idx
  ON theme (is_long_running) WHERE is_long_running = true;
