-- Persist the full ComposerInput that produced each issue. Enables
-- composer-replay: load a past issue's input and re-render with a
-- different composer prompt or model, without re-running ingest/score
-- or touching live DB state. Without this we only had editor_output +
-- shrug pool saved, which is not enough to reconstruct the composer's
-- view (items, theme_timelines, synthesis_themes are all built at
-- compose time).

ALTER TABLE issue
  ADD COLUMN composer_input_jsonb jsonb;
