-- Re-encode the embedding columns from vector(1024) (4 bytes/dim) to
-- halfvec(1024) (2 bytes/dim). Halves both the columns and their
-- ivfflat indexes — the largest single line in the database. See
-- docs/storage.md.
--
-- Why this is safe: cosine distance over fp16 has ~1e-3 quantization
-- error, far below our decision margins (attach 0.70, recheck 0.88,
-- dedup 0.95). And embeddings are DERIVED data — reembed.ts rebuilds
-- any of them from title + scorer_summary — so this is a lossy-but-safe
-- re-encode, not a change to the persist-forever substrate
-- (raw_input/raw_output).
--
-- The ALTER COLUMN TYPE rewrites each table, which also reclaims any
-- accumulated heap bloat. Indexes must be dropped before the type
-- change and rebuilt with the halfvec operator class afterward.

-- story.embedding
DROP INDEX IF EXISTS story_embedding_idx;
ALTER TABLE story
  ALTER COLUMN embedding TYPE halfvec(1024)
  USING embedding::halfvec(1024);
CREATE INDEX story_embedding_idx
  ON story USING ivfflat (embedding halfvec_cosine_ops);

-- theme.centroid_embedding
DROP INDEX IF EXISTS theme_centroid_idx;
ALTER TABLE theme
  ALTER COLUMN centroid_embedding TYPE halfvec(1024)
  USING centroid_embedding::halfvec(1024);
CREATE INDEX theme_centroid_idx
  ON theme USING ivfflat (centroid_embedding halfvec_cosine_ops);
