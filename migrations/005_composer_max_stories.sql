-- Cap the number of stories in a single issue. Gate continues to mark
-- stories eligible (passed_gate=true); composer picks the top N by
-- composite. Stories that pass the gate but are cut here stay unpublished
-- and are eligible for the next issue.
INSERT INTO config (key, value) VALUES
  ('composer.max_stories', '7'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
