-- Cron-like in-app scheduler state. Replaces the five Fly scheduled
-- machines (ingest/dispatch/score/weekly/retention) with a single
-- hourly tick that consults these tables. Operator edits intervals
-- and enabled flag via /admin/scheduler; changes take effect on the
-- next tick (≤1h) without a redeploy.
--
-- pipeline_lock (mig 024) still owns "is X running right now" — the
-- stages themselves wrap their bodies in withLock and are unchanged.
-- pipeline_run answers "when did X last succeed" and "what was the
-- error" so the scheduler can compute next-due and the admin UI can
-- show history.

CREATE TABLE pipeline_schedule (
  stage text PRIMARY KEY,
  interval_sec int NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO pipeline_schedule (stage, interval_sec) VALUES
  ('ingest',    3600),
  ('dispatch',  3600),
  ('score',     86400),
  ('retention', 86400),
  ('compose',   604800);

CREATE TABLE pipeline_run (
  id serial PRIMARY KEY,
  stage text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'running', -- running | success | error
  error text,
  duration_ms int,
  triggered_by text NOT NULL DEFAULT 'cron' -- cron | manual | deploy
);

CREATE INDEX pipeline_run_stage_started_idx
  ON pipeline_run (stage, started_at DESC);

-- Specialized index for "last successful run of stage X" — the
-- scheduler's hot query on every tick.
CREATE INDEX pipeline_run_stage_success_idx
  ON pipeline_run (stage, completed_at DESC)
  WHERE status = 'success';
