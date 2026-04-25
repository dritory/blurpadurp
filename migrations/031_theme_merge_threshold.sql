-- Theme-to-theme merge threshold. Higher than the singleton-attach
-- threshold because we're merging two established themes — false
-- positives are more disruptive (you're collapsing two existing
-- story-arc labels into one). 0.85 catches the Tim Cook + Apple CEO
-- succession case (~0.95 cosine) without dragging in semantically
-- adjacent but distinct arcs at 0.70.
INSERT INTO config (key, value) VALUES
  ('theme.merge_threshold', '0.85'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
