-- Persist the most recent error per (connector, scope) so the admin
-- /admin/sources page can show "gdelt last failed with: <message>"
-- without relying on Fly's log retention. ingest.ts writes the error
-- on the catch path of runConnector and clears it (NULL) on success.
--
-- Lives on source_cursor since it's already per (connector, scope)
-- and has the connection to data progress; a separate table would
-- duplicate the PK structure.

ALTER TABLE source_cursor ADD COLUMN last_error text;
ALTER TABLE source_cursor ADD COLUMN last_error_at timestamptz;
ALTER TABLE source_cursor ADD COLUMN last_run_at timestamptz;
