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

### 5b. No issues going out / a draft is stuck

**Symptom:** Weeks pass with no brief. Nothing errors. `/admin/scheduler`
shows compose "succeeding" or simply never firing.

**Start here: `/admin/release`.** It lists every current blocker (open
draft, held lock, cadence gap, next anchored compose) and counts the
unpublished backlog by age band, flagging the bands that are already
past the 7-day compose window and will never ship through a normal run.
That page exists specifically for this failure; the rest of this entry
is the underlying mechanism.

**Quick diagnosis:** Open `/admin/issues` and look for an open draft.
`runCompose` bails while *any* `is_draft` row exists — it logs
`[compose] open draft #N exists — publish or discard it first, skipping`
and returns success. One forgotten draft therefore blocks every compose
behind it, and the failure is invisible unless you read the logs. This is
what silently ate three weeks of briefs before mig 066.

**Deploying onto an existing stuck draft is safe.** Migrations run
automatically (`release_command = "bun run migrate"`), and the sweep
will not mail a draft older than `compose.auto_publish_max_age_hours`
(72h) — it holds it and notifies instead. So you don't have to race the
first tick to stop an old draft going out; deploy, then discard at your
leisure.

**Immediate:** Check the auto-publish banner at the top of
`/admin/review/<id>`. It says one of:

- *Publishes automatically at …* — nothing to do, it will clear itself.
- *Too stale to auto-publish: N days old* — past the ceiling. The sweep
  will hold it, never send it. Discard is almost always right; publish
  by hand only if you truly want a stale brief mailed. Clearing the hold
  achieves nothing — the next sweep re-holds it for the same reason.
- *Auto-publish will hold this draft: N un-glossed terms remain* — the
  checker couldn't fix it in its allotted passes. Fix the gloss by hand
  and publish, or publish anyway if the findings are false positives.
- *Held* — either you parked it or the sweep did. Clear the hold to hand
  it back to the sweep.
- *Auto-publish is off* — `compose.auto_publish_enabled` is false in
  `/admin/config`.

If the draft is simply stale (weeks old), **discard** rather than
publish. Discarding deletes the issue row and returns its stories to the
pool (they were never marked `published_to_reader`); publishing would
mark three-week-old stories as used and burn them.

**If discard fails with a foreign-key error** — `update or delete on
table "issue" violates foreign key constraint
"dispatch_log_issue_id_fkey"` — the draft has already been emailed to
reviewers. `dispatch_log.issue_id` has no `ON DELETE CASCADE`, unlike
`issue_pick` / `issue_annotation`. `discardDraft` clears the draft's
send-log rows inside its transaction, so an up-to-date deploy handles
this. On an older deploy the manual equivalent is:

```sql
BEGIN;
DELETE FROM dispatch_log
 WHERE issue_id = <id>
   AND EXISTS (SELECT id FROM issue WHERE id = <id> AND is_draft = true);
DELETE FROM issue WHERE id = <id> AND is_draft = true;
COMMIT;
```

The `EXISTS` guard is load-bearing: without it a mistyped id would wipe
a *published* issue's send log. Losing a draft's rows is fine — they
record sends for an issue that never shipped, and bounce suppression
lives on `email_subscription.unsubscribed_at`, not here.

**Recovering a backlog after a gap.** Once the blocking draft is gone,
`/admin/release` shows what's strandable. A normal compose only ever
sees the last 7 days, so anything older ages out unread. To recover it,
queue a **catch-up run** from that page:

- *Compose with selected* — you tick the specific stories. Preferred:
  deciding which quiet items still deserve air is editorial judgment.
- *Compose with top N by rank* — takes the highest
  `structural_importance × half_life` items automatically.
- *Compose fresh week only* — a plain run, ignoring the backlog.

Catch-up candidates are ranked on durable significance and the gate is
deliberately ignored, so gate-failing stories can and should appear —
those are the quiet×significant picks. The fresh week is still selected
normally and still dominates the issue; the editor may cut every
catch-up item, which is a legitimate outcome. A catch-up run also
bypasses `compose.min_publish_gap_hours`, since it's an explicit
operator action rather than the cadence firing.

**Root cause:** Pre-066, nothing bounded how long a draft could sit.
Now the autopublish sweep does. If a draft is stuck *despite* the sweep,
check that the `autopublish` stage is enabled on `/admin/scheduler` and
that its lock isn't wedged (clear it there).

**Note on the fixed day:** compose is anchored to Saturday 06:00 UTC via
`pipeline_schedule.cron_dow` / `cron_hour`, and `interval_sec` is ignored
for anchored stages. If briefs stop arriving on the right day, check
those two columns before touching the interval. An anchored stage that
misses its slot waits for the next one rather than firing on the wrong
day — that's deliberate.

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

### 13. Site down / 5xx on a cold start

**Symptom:** The public site is unreachable for a minute or two and the
external health monitor emails. `fly logs -a blurpadurp` shows a burst
of:
```
[PM07] failed to change machine state: machine still active, refusing to start
[PR03] could not find a good candidate within 1 attempts at load balancing
[PM01] machines API returned an error: "rate limit exceeded"
```
followed eventually by a fresh boot, a transient `[PC01] instance
refused connection ... listening on 0.0.0.0:3000?`, and a delayed
`Health check ... is now passing`.

**Quick diagnosis:** This is the single autostopping machine racing its
own stop. With `min_machines_running = 0` there is exactly one machine;
if a request arrives while it is mid-stop, Fly refuses to start a machine
it still considers "active," the proxy retries hard, and the retries trip
the Machines API rate limit — which *lengthens* the stall. The
connection-refused line is a separate, benign listen race (proxy beat the
app to the socket by a few ms). Confirm it's not an app crash: there
should be no panic/exit in the logs, and `Machine started in N.Ns`
appears.

**Immediate:**
- Usually self-heals once the stop completes and the next request boots a
  fresh machine. If it's wedged, force it: `fly machine restart <id> -a blurpadurp`.
- Verify it's serving: `curl -fsS https://blurpadurp.fly.dev/health`
  (DB-less probe — a 200 means the process is up regardless of Neon).

**Root cause:** Inherent to one scale-to-zero machine. We deliberately
stay at `min = 0` to track Neon's idle (the R2 page cache means an
always-warm machine wouldn't even save Neon CU — it'd just cost Fly
compute). Mitigations in place: `auto_stop_machines = "suspend"` (resume
from RAM, shorter cold-start/listen-race window) and a 15s health-check
interval (so a failed post-boot check re-probes in 15s, not 60s). To
eliminate the race entirely you'd need `min_machines_running = 1` or 2
machines — a cost call, intentionally not taken.

**Adjacent noise — pg SSL deprecation warning:** A cold home-page request
that misses the R2 cache falls through to Neon and may print a
`SECURITY WARNING: The SSL modes 'prefer', 'require' ...` stack trace
through `loadLatestIssue`. That is a `process.emitWarning`, **not** a
crash — the request succeeds; ignore it during triage. Do **not**
"fix" it by rewriting the connection string to `sslmode=verify-full`:
`require` encrypts without enforcing CA-chain + hostname checks, but
`verify-full` enforces both, and against Neon's pooler endpoint (and a
container that may lack the matching root CAs) that turns a harmless
warning into a hard connection failure on *every* query. If the warning
must go, pin/upgrade `pg-connection-string` and pass an explicit `ssl`
object that matches today's behavior (`rejectUnauthorized: false`),
verified against the real endpoint first — not a stricter mode.

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
