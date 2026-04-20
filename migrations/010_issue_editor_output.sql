-- Persist the editor stage's full output (picks + cuts_summary) onto
-- the issue row, so the admin review page can show what got cut and why
-- without joining ai_call_log by input_hash. Same idea as story.raw_output.
--
-- Also stash the shrug candidates the composer saw — useful for tuning
-- the shrug pool thresholds.

ALTER TABLE issue
  ADD COLUMN editor_output_jsonb jsonb,
  ADD COLUMN shrug_candidates_jsonb jsonb;
