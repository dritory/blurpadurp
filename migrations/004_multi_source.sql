-- Multi-source citation: each story can track additional URLs where the
-- same event was reported, and the event-level GDELT metrics populate
-- the gdelt_metadata path on raw_input. The canonical URL stays in
-- source_url.
ALTER TABLE story
  ADD COLUMN additional_source_urls text[] NOT NULL DEFAULT '{}';
