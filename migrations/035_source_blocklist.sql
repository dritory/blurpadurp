-- Per-host blocklist. Stories whose source_url host (or any parent
-- domain) appears here are dropped at the ingest boundary, before
-- embedding/scoring spend. Granularity: any subdomain of a blocked
-- host counts as blocked (e.g. blocking nypost.com also blocks
-- video.nypost.com), implemented in src/shared/source-blocklist.ts.
--
-- Stored hosts are lowercase, leading "www." stripped. The admin
-- "Block this source" buttons enforce that normalization on insert.
--
-- Hosts come off the list via DELETE — no archive table.

CREATE TABLE source_blocklist (
  host text PRIMARY KEY,
  reason text,
  blocked_at timestamptz NOT NULL DEFAULT now()
);
