-- Adds live progress reporting to pipeline_run. Stages that loop over
-- a known-size batch (score, ingest) call reportProgress() to update
-- these columns; /admin/scheduler reads them to show "running 24/142"
-- instead of just "lock held". Both nullable: short stages don't have
-- to wire up reporting, and old rows pre-dating this column stay
-- valid.

ALTER TABLE pipeline_run
  ADD COLUMN progress_done int,
  ADD COLUMN progress_total int;
