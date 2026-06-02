-- Cold-storage tier, phase 2: story.raw_input / raw_output.
--
-- The hot scoring path no longer reads raw_output (it reads
-- story.scorer_summary, mig 055), so the bulky scorer I/O payloads are
-- cold — touched only by fixture-capture, the admin drilldown, and the
-- eval picker. They follow ai_call_log into R2. See docs/storage.md.
--
-- payload_key points at an R2 object holding {"input":raw_input,
-- "output":raw_output}. When set, raw_input/raw_output are NULL. The
-- read path falls back to the inline columns whenever payload_key is
-- NULL, so this is safe to ship before any data moves. Governed by the
-- same storage.cold_tier flag as ai_call_log (mig 057).

ALTER TABLE story ADD COLUMN payload_key text;
