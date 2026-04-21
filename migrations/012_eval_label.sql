-- Hand-labeled evaluation set. The operator assigns a verdict to a
-- story ("yes this belongs in a brief", "maybe", "no") — this becomes
-- the ground truth against which the scorer's precision/recall is
-- measured. Without this, we have no objective way to tune prompts or
-- compare models; with it, every prompt bump gets a measurable delta.
--
-- One label per story (UNIQUE). Relabeling happens via UPDATE.

CREATE TABLE eval_label (
  story_id bigint PRIMARY KEY REFERENCES story(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (label IN ('yes', 'maybe', 'no', 'skip')),
  notes text,
  labeled_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX eval_label_label_idx ON eval_label(label);
