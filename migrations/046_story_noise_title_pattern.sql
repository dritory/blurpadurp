-- Mirror of story.noise_pattern (URL-path match) for title regex
-- matches. Tag-mode title filters set this column so the operator
-- can audit which stories were caught before promoting to block.
-- Block-mode title matches drop the story at ingest, so this column
-- is only ever set by tag-mode patterns.
--
-- Two columns rather than one shared field because the matchers are
-- semantically different (substring vs regex) and a story can match
-- both kinds — keeping them separate avoids order-of-precedence
-- ambiguity in the data.

ALTER TABLE story ADD COLUMN noise_title_pattern text;

CREATE INDEX story_noise_title_pattern_idx
  ON story (noise_title_pattern)
  WHERE noise_title_pattern IS NOT NULL;
