# Runbook

What to do when things go wrong. Pre-written so future-you isn't
reinventing triage at 2 AM. Each entry: **symptom → quick diagnosis →
immediate response → root-cause follow-up**.

Every entry assumes shell access and DB access. No external observability
beyond `ai_call_log` and `dispatch_log` for v0.

---

## AI / pipeline

### 1. Cost spiked

**Symptom:** Anthropic billing alert, or a `BudgetExceededError` in logs,
or `SELECT sum(cost_estimate_usd) FROM ai_call_log WHERE started_at >
now() - interval '1 day'` exceeds the daily cap.

**Quick diagnosis:**
```sql
SELECT stage_name, count(*), sum(cost_estimate_usd)
FROM ai_call_log
WHERE started_at > now() - interval '1 day'
GROUP BY stage_name ORDER BY 3 DESC;
```
Likely culprits: scorer in a retry loop; composer called repeatedly
because its cache is missing.

**Immediate:**
- Bump `config.budget.daily_usd_cap` to 0 to block all AI calls while
  investigating: `UPDATE config SET value = '0'::jsonb WHERE key = 'budget.daily_usd_cap'`.
- Restore once root cause found.

**Root cause:** Either an ingest flooded the scorer (check `count(*) FROM
story WHERE scored_at IS NULL AND ingested_at > now() - interval '1 day'`)
or cache-key changed unexpectedly (check `distinct stage_version` in
`ai_call_log`). A prompt-version bump without migration is the classic.

### 2. Scorer hallucinating / ignoring the schema

**Symptom:** `ScorerOutputSchema.parse()` throws, logs show
`ZodError: classification.category Expected enum, got "entertainment"`.

**Quick diagnosis:** read the raw output in `ai_call_log.output_jsonb`
for the failing row. Does the model invent new category slugs? New
factor tags? A malformed score (e.g. `5.5` when schema wants integer)?

**Immediate:**
- Pause `score` (don't run `bun run cli score`).
- Inspect the prompt-version currently in use:
  `SELECT value FROM config WHERE key = 'scorer.prompt_version'`.
- If drift is isolated to one row (bad input, not bad prompt), skip it
  by marking `early_reject = true` manually and note the story_id.

**Root cause:** Model version changed under us (check Anthropic status)
or a prompt edit relaxed the schema guards. Run the fixture/replay
harness against the last known-good prompt+model combo to confirm the
prompt is fine. If not, roll prompt_version back via migration pattern.

### 3. Gate firing too often / too rarely

**Symptom:** Issues are huge (many passers) or empty for weeks.

**Quick diagnosis:**
```sql
SELECT date_trunc('week', scored_at) w,
       count(*) total,
       count(*) FILTER (WHERE passed_gate) passed
FROM story WHERE scored_at > now() - interval '4 weeks'
GROUP BY w ORDER BY w;
```

**Immediate:** Tune `config.gate.x_threshold`. Default is 5; raise to 6
to tighten, lower to 4 to loosen. The `editor` stage will still cap
issue size at 10–15 — so gate tuning only affects what reaches the
editor, not issue length.

**Root cause:** Real-world news volume shifted (election week, war
breakout) or scorer drifted. Check composite distribution:
```sql
SELECT width_bucket(composite, 0, 25, 25) b, count(*)
FROM story WHERE scored_at > now() - interval '2 weeks'
GROUP BY b ORDER BY b;
```
A shifted mode means the scorer's calibration drifted.

### 4. Editor picking all-the-same-angle stories

**Symptom:** An issue has five Iran stories, three Trump stories, and
nothing else. Reader feedback says "this feels like a wire service."

**Quick diagnosis:** Read `/admin/review/:issue_id`. The editor's
`cuts_summary` should explain the balance. If it doesn't, the editor
prompt's "topic balance" rule isn't firing.

**Immediate:** Nothing. Silence is a feature — if the week was genuinely
one-topic, reflecting that is correct. But if you disagree with the
editor's read, the right move is prompt iteration, not a DB patch.

**Root cause:** Editor prompt's topic-balance rule is under-specified
for lopsided weeks. Iterate via the fixture/replay harness:
capture the passer pool, run the editor against a revised prompt,
compare picks.

### 5. Composer regresses to gray / generic voice

**Symptom:** You read the issue and it sounds like a wire service.

**Quick diagnosis:** Grep the composer prompt for "Gold examples". Are
they still present, still short, still sharp? Has the prompt version
bumped since the last good issue?

**Immediate:** None — don't hot-patch the prompt. Write a note on what
bothered you (specific phrases, specific registers), then iterate via
fixture/replay on the composer once you have a captured issue to replay
against.

**Root cause:** Anthropic model update (rare, announced) or prompt drift
(common). Longer-term: the retrospective voice-drift tool we discussed
would catch this automatically — not built yet.

---

## Ingestion

### 6. GDELT connector empty / timing out

**Symptom:** `bun run cli ingest` reports zero new rows repeatedly.

**Quick diagnosis:**
- Is BigQuery reachable at all? `bun run cli ingest` logs will show the
  `computeRange` window.
- GDELT publishes on a 15-minute delay; a window shorter than that
  returns empty. Check `source_cursor.last_seen_at`.
- Did the `_PARTITIONTIME` literal lose the date-floor adjustment?
  (Comment in `gdelt.ts` warns about this — the pruner is picky.)

**Immediate:** Reset the cursor to 24 hours back:
```sql
UPDATE source_cursor SET last_seen_at = now() - interval '24 hours'
WHERE connector_name = 'gdelt' AND scope_key = 'global';
```
Retry ingest.

**Root cause:** BigQuery quota, partition-pruner regression, or GDELT
itself stopped publishing. Check the GDELT status page before assuming
it's our bug.

### 7. RSS connector pulls stale evergreen content

**Symptom:** Stories show up with `published_at` from 2019.

**Quick diagnosis:** RSS feeds occasionally republish old articles with
fresh pubDates. The `ingest` date filter should catch this; check it's
firing. Grep `compose.ts` for `COMPOSE_INGEST_WINDOW_MS`.

**Immediate:** Safe to ignore — the 14-day compose window excludes
stale content from issues. But if it leaked into a published issue,
that's a bug in the window filter.

**Root cause:** Look at the offending feed's behavior. Some outlets
(BBC, Bloomberg) republish with fresh pubDates when they update
articles — treat those as new if substantively different, skip
otherwise. Whitelist/blacklist can go in `src/connectors/rss.ts`.

---

## Site / subscriptions

### 8. /subscribe flooded with garbage emails

**Symptom:** Thousands of rows in `email_subscription` with obvious
fake addresses.

**Quick diagnosis:**
```sql
SELECT count(*), date_trunc('hour', created_at) h
FROM email_subscription
WHERE created_at > now() - interval '24 hours'
GROUP BY h ORDER BY h;
```
Spikes suggest a script.

**Immediate:**
- Delete unconfirmed rows older than 72 hours:
  `DELETE FROM email_subscription WHERE confirmed_at IS NULL AND created_at < now() - interval '72 hours'`.
- Tighten the rate-limit in `src/shared/rate-limit.ts` (drop capacity
  to 2, slow refill to 1/min).
- Consider putting Cloudflare Turnstile on the form.

**Root cause:** Bot farm. Our honeypot + rate-limit is a speed bump,
not a wall. If it's sustained, Turnstile or equivalent is the right
answer.

### 9. Email dispatch double-sending

**Symptom:** A reader reports getting two copies of the same issue.

**Quick diagnosis:**
```sql
SELECT issue_id, subscription_id, count(*)
FROM dispatch_log
WHERE subscription_kind = 'email'
GROUP BY 1, 2 HAVING count(*) > 1;
```
This should be impossible — there's a UNIQUE constraint. If it returns
rows, the constraint is missing.

**Immediate:** Verify the constraint: `\d dispatch_log`. If present and
zero duplicates in the log, the reader is seeing Gmail's threading /
their own filters — ask for the Message-ID headers.

**Root cause:** If the constraint is truly gone, a migration went wrong.
Re-add it:
```sql
ALTER TABLE dispatch_log ADD CONSTRAINT dispatch_log_unique
  UNIQUE (issue_id, subscription_kind, subscription_id);
```

### 10. Unsubscribe link doesn't work

**Symptom:** Reader clicks Unsubscribe, nothing visible happens (or
sees "link invalid").

**Quick diagnosis:** Paste the token body (before the `.`) into a
base64-URL decoder; check `k` (should be `unsubscribe-email`), `id`
(should match a real `email_subscription.id`), `e` (not in the past).

**Immediate:** If the token is valid but unsubscribe didn't flip the
row, run it manually:
`UPDATE email_subscription SET unsubscribed_at = now() WHERE id = <id>`.
Apologize to the reader. (RFC 8058 requires one-click unsubscribe; our
reliability on this is non-negotiable.)

**Root cause:** `BLURPADURP_TOKEN_SECRET` was rotated (invalidates all
prior tokens) or the endpoint code broke. Don't rotate the secret in
production without re-issuing tokens on the next issue.

---

## DB / infra

### 11. Migrations stuck

**Symptom:** `bun run migrate` hangs or errors partway through.

**Quick diagnosis:**
- Is someone else connected? `SELECT * FROM pg_stat_activity WHERE state = 'active'`.
- Did a prior migration half-complete and leave a dangling lock?
  `SELECT * FROM pg_locks WHERE NOT granted`.
- Our migrator wraps each file in a transaction, so partial-apply is
  prevented — but a long-running query from another session can block.

**Immediate:** Kill the blocking session if safe. Retry.

**Root cause:** A DDL in a migration conflicts with live reads. For
v0.1 we don't expect this — traffic is zero. Revisit when we have
concurrent traffic.

### 12. pgvector index rebuild needed

**Symptom:** Theme attachment returns bad nearest-neighbors after
~10k rows.

**Quick diagnosis:** The `ivfflat` index starts hurting when the
corpus outgrows its `lists` parameter. Check index stats.

**Immediate:** Rebuild with a higher lists value (~sqrt(row_count)):
```sql
DROP INDEX story_embedding_idx;
CREATE INDEX story_embedding_idx ON story
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 200);
```

**Root cause:** Not a bug — an operational knob. Revisit ~50k rows.

---

## General triage rules

1. **Don't hot-patch prompts in production.** Capture, replay, review,
   then bump the version via migration.
2. **Preserve `ai_call_log` rows.** Never delete them; they're the
   surrogate-model training set and the drift-detection substrate.
3. **When in doubt, silence.** A missed issue is a paper cut; a wrong
   issue is a broken trust contract.
4. **Every fix should leave a test or a log query behind.** The next
   time this happens, someone should be able to diagnose it faster.
