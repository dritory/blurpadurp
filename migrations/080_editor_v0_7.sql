-- Editor v0.7: the bottom rank band gets a meaning.
--
-- The editor's ranks have always become sections (1-5 lead, 6-10 Worth
-- knowing, 11+ Worth watching; src/pipeline/compose-partition.ts), and
-- the reader is told Worth watching holds threads still developing. But
-- the prompt told the editor the tail was "a reserve, expect them to
-- fall off", so the band meant "least confident keeps" to the model and
-- "still in motion" to the reader. The section's content was whatever
-- was left over, and it read as developing threads only by luck.
--
-- v0.7 defines the 11+ band as stories whose decisive beat hasn't
-- happened yet, says a settled-but-minor story that misses the top ten
-- is a cut rather than a rank 11, and drops the reserve framing. The
-- routing and the downstream trim are unchanged.
--
-- Bumping the version string invalidates cache-on-hash lookups, so the
-- next compose is fresh output against the corrected prompt.
UPDATE config
SET value = '"editor-v0.7"'::jsonb, updated_at = now()
WHERE key = 'editor.prompt_version';
