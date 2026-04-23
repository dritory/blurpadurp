-- Persist the editor's input alongside its output so editor-replay can
-- re-run the editor stage with a different prompt/model against the
-- exact pool the original editor saw. Mirrors `composer_input_jsonb`.

ALTER TABLE issue ADD COLUMN IF NOT EXISTS editor_input_jsonb jsonb;
