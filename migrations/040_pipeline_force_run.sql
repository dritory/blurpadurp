-- Force-run queue. /admin/run/:stage inserts a row here and the next
-- scheduler-tick (≤1h away) drains it, firing the queued stages
-- regardless of their cooldown. The row is deleted before firing so
-- a crash mid-run does not auto-retry — operator clicks "Run now"
-- again to re-queue.
--
-- Manual triggers don't run inline on the http_service: long-running
-- stages (score on a backlog can be 30+ min) outlast Fly's idle-stop
-- timer on the http_service group, killing the work mid-flight. The
-- scheduler machine is short-lived per fire and not idle-stopped, so
-- it's the right place for any pipeline work.

CREATE TABLE pipeline_force_run (
  stage text PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now()
);
