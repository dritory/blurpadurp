-- Retention age-out window for individual story embeddings. An
-- embedding does real work only inside the dedup lookback
-- (scorer.dedup_lookback_days = 3 days) and, after that, only while
-- its theme is still actively gaining members. Beyond that it is dead
-- weight in the story_embedding_idx ivfflat index.
--
-- The daily retention stage nulls story.embedding for stories scored
-- more than this many days ago whose theme is dormant (no member
-- scored within the same window). Default 90 — 30x the dedup window,
-- generous headroom. Embeddings are derived data; reembed.ts
-- regenerates any of them on demand. See docs/storage.md.

INSERT INTO config (key, value) VALUES
  ('retention.embedding_hot_days', '90'::jsonb);
