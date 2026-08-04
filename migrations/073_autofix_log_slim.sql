-- Stop auto_fix_jsonb from eating the storage budget.
--
-- Two bugs from mig 071/072 compounded into unbounded write volume on
-- the issue row, which on Neon is unbounded STORAGE — the reported
-- number includes branch history for the PITR window, so a row rewritten
-- hourly is retained hourly.
--
-- 1. THE LOG CARRIED PROSE. mig 072 put original_markdown on
--    auto_fix_jsonb as the before/after anchor, on top of the
--    passes[].markdown_before that was already there. That is up to three
--    full copies of the brief in one jsonb column, on a row that already
--    holds composed_markdown + composed_html. Past ~2KB jsonb is TOASTed,
--    so every UPDATE rewrote the TOAST chunks too.
--
--    It was also redundant. Every composer call's input and output is
--    already in ai_call_log keyed by input_hash — the persist-forever
--    replay substrate, and the tier that actually has a cold-storage path
--    to R2 (mig 057). Copying prose onto a hot, never-offloaded row was
--    the wrong tier. The log now keeps findings, notes and content
--    hashes; recover prose with `bun run cli composer-replay <issue>`.
--
-- 2. IT NEVER CONVERGED. mig 071 has the sweep retry while a draft is
--    dirty, capped by cumulative attempts. But two early-exit paths
--    (initial check failed, no composer_input to recompose from) returned
--    without incrementing attempts, and shouldRetryAutoFix reads
--    outcome="failed" as retryable. So those drafts were re-run every
--    hour forever, each run rewriting the fat jsonb. A draft with no
--    composer_input could never converge by construction.
--
--    Fixed by counting RUNS as well as attempts and capping both, so no
--    accounting bug in any one path can produce an unbounded loop again.
--
-- Strip the prose from existing rows. jsonb '-' removes a key; the
-- passes rewrite drops markdown_before from each element. Reclaims the
-- logical bytes immediately, but on Neon the reported storage only falls
-- once the history window rolls past (or the branch is reset) — see the
-- runbook.
UPDATE issue
SET auto_fix_jsonb = (
      (auto_fix_jsonb - 'original_markdown')
      || jsonb_build_object(
           'passes',
           COALESCE(
             (SELECT jsonb_agg(p - 'markdown_before')
              FROM jsonb_array_elements(auto_fix_jsonb -> 'passes') AS p),
             '[]'::jsonb
           )
         )
    )
WHERE auto_fix_jsonb IS NOT NULL
  AND (
    auto_fix_jsonb ? 'original_markdown'
    OR auto_fix_jsonb -> 'passes' @> '[{"markdown_before": null}]'
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(auto_fix_jsonb -> 'passes') AS p
      WHERE p ? 'markdown_before'
    )
  );
