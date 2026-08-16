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

### 8b. Published an issue, no emails arrived

**Symptom:** The issue is live on `/` and `/archive`, inboxes are empty.

Publish and send are two different stages. Publishing flips `is_draft`
and busts the page cache; the mail waits for the dispatch sweep, which
runs on a **6h** cadence (mig 053). `publishDraft` queues a
`pipeline_force_run` row so the next hourly tick sends — but that's
still up to an hour, and the first thing to rule out is simply "it
hasn't run yet".

**Quick diagnosis**, in order — stop at the first one that answers it:

```sql
-- 1. has dispatch run since the publish? (also /admin/status)
SELECT status, started_at, completed_at, error
FROM pipeline_run WHERE stage = 'dispatch'
ORDER BY started_at DESC LIMIT 5;

-- 2. is the stage even switched on?
SELECT * FROM pipeline_schedule WHERE stage = 'dispatch';
SELECT * FROM pipeline_force_run;      -- pending queue

-- 3. what did the sweep decide for this issue?
SELECT status, count(*) FROM dispatch_log
WHERE issue_id = <id> AND subscription_kind = 'email' GROUP BY 1;

-- 4. is the audience non-empty?
SELECT count(*) FROM email_subscription
WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL;
```

Reading step 3:

- **`noop`** — `RESEND_API_KEY` is unset on the machine that ran the
  sweep. The mailer logs the send and returns success by design (keeps
  dev cheap), so this is the one failure that looks like a clean run in
  every log and counter. Check `fly secrets list`.
- **`error_permanent` / `error_transient`** — read the `error` column;
  usually an unverified sending domain or a bad `FROM_EMAIL`.
- **`sent` but nothing received** — it left the building. Resend
  dashboard, then spam/DMARC. Check `/webhooks/resend` is registered:
  without it, bounces never come back.
- **no rows at all** — nobody matched the pair query. Three filters do
  this: `confirmed_at IS NULL` (subscribed but never clicked confirm),
  `unsubscribed_at IS NOT NULL`, and `published_at >= confirmed_at` —
  a subscriber only gets issues published *after* they confirmed, so a
  brand-new subscriber is correctly skipped for an issue that predates
  them.

**Immediate:** force a sweep — "Run now" on `/admin/scheduler`, or
`bun run cli dispatch`. Dispatch is at-most-once per (issue,
subscription), so a `noop`/error row blocks the retry. After fixing the
cause, clear only the un-sent rows and re-run:

```sql
DELETE FROM dispatch_log
WHERE issue_id = <id> AND subscription_kind = 'email'
  AND status IN ('noop', 'error_permanent', 'error_transient');
```

Never delete `sent` / `delivered` / `delayed` rows — that's how you
mail the same issue twice.

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

### 14. Neon storage full / writes failing / publish crashes

**Symptom:** Neon reports the project at its storage limit. Writes start
failing, which surfaces as a crash anywhere that writes — most visibly
`publishDraft`, since it runs three UPDATEs in one transaction. A read-only
Neon looks like an application bug at the call site that happened to write
first.

**Quick diagnosis:** `/admin/status` reports per-table sizes
(`pg_total_relation_size`). Check the top three. Then:

```sql
-- Is one issue row carrying an absurd auto-fix log?
SELECT id, is_draft,
       pg_column_size(auto_fix_jsonb)  AS autofix_bytes,
       auto_fix_jsonb -> 'runs'        AS runs,
       auto_fix_jsonb -> 'attempts'    AS attempts,
       auto_fix_jsonb -> 'outcome'     AS outcome
FROM issue
WHERE auto_fix_jsonb IS NOT NULL
ORDER BY pg_column_size(auto_fix_jsonb) DESC
LIMIT 10;

-- How much of ai_call_log is still inline rather than tiered to R2?
SELECT payload_key IS NULL AS inline, count(*),
       pg_size_pretty(sum(pg_column_size(input_jsonb)
                        + pg_column_size(output_jsonb))) AS payload
FROM ai_call_log GROUP BY 1;
```

A `runs` value in the dozens on an open draft means the auto-fix sweep was
looping (the mig 073 bug); a large inline `ai_call_log` means cold-migrate
has never been run.

**Three independent causes. Establish which one you have before acting —
the first is a slow leak measured in months, the other two in hours.**

0. **Ordinary corpus growth, which is the usual answer.** Every ingest
   writes a story row per item that clears the filters; ~10-15 a week are
   ever published. If storage has been climbing steadily for weeks and
   was already near the cap before any recent deploy, it is this, and the
   two levers are retention rule 5 (deletes unscored noise, mig 074) and
   `storage.cold_tier` (tiers scored payloads to R2). **Check the flag
   first:** mig 057 ships `storage.cold_tier = false`, so a project that
   has never flipped it has never offloaded a payload — retention calls
   `offloadPayloads` on a schedule, but the call is inert. That single
   config flip is usually the largest available reclaim.

1. **The auto-fix sweep looping on a fat row.** mig 071 has the sweep
   retry hourly while a draft is dirty; mig 072 put the composer's full
   prose on `auto_fix_jsonb`. Two early-exit paths didn't increment the
   attempt counter, so a draft that failed those checks re-ran every hour
   forever, each run rewriting three copies of the brief. Fixed in mig 073
   (prose out of the log, `runs` as a bound no per-path bug can defeat) —
   but note the shape, because **on Neon a write loop is a storage leak.**
   Reported storage includes branch history for the PITR window, so an
   hourly rewrite of a TOASTed column is retained hourly for the whole
   window even though the logical table never grows.

2. **`cold-migrate` is CLI-only.** It is not a scheduled stage, so
   `ai_call_log` input/output payloads accumulate inline indefinitely
   unless someone runs it. On a long-lived project this is usually the
   bulk of the storage.

**Immediate — reclaim, in order of yield:**
- Set `storage.cold_tier = true` at `/admin/config`, then run
  `bun run cli cold-migrate` to drain the backlog without waiting for the
  nightly retention pass. Needs `R2_BUCKET` + `R2_ACCESS_KEY_ID` +
  `R2_SECRET_ACCESS_KEY`; it is a no-op without them, so check first.
  Rows stay — only payloads move, so persist-forever holds. On a database
  that has never tiered, this is the big one.
- `bun run cli migrate` to apply mig 073 (strips prose from auto-fix logs)
  and mig 074 (enables the unscored-noise prune). Then
  `bun run cli retention` to run the prune now; it is bounded to 5000 rows
  per pass, so a large backlog drains over several daily runs.
- Then **shrink the Neon history window** (project → Settings → history
  retention; free tier defaults to 7 days). Logical deletes do not reduce
  reported storage until history rolls past them. This is the step people
  skip and then conclude the cleanup didn't work.
- Do **not** delete `ai_call_log` rows to free space. They are the replay
  substrate and the drift-detection baseline (invariant 3, triage rule 2).
  Tier them to R2 instead.

**Prevention:** any hourly stage that UPDATEs a row must be bounded by a
counter incremented *before* anything can fail, and must not write bulk
payloads to a row it rewrites. Bulk belongs in `ai_call_log` (keyed by
`input_hash`, cold-tierable) or R2 — see `docs/storage.md`.

---

### 15. A heartbeat mail arrived (or stopped arriving)

**The two mails, and what each means.**

- **"`<stage>` failed"** — the scheduler's catch block. A stage threw on
  its latest run. It is *not* skipped: due-ness is computed from
  `last_success_at`, so a failing stage stays due and retries next tick.
  Repeats are rate-limited by consecutive-failure count (1st, 2nd, 4th,
  8th…), so an escalating subject line — "(8× in a row)" — means it has
  been broken for at least eight ticks, not that it got worse.
- **"Pipeline needs attention"** — the `heartbeat` stage (every 6h,
  mig 078). It reports the failures that never throw. Re-sent at most
  every `heartbeat.alert_interval_hours` (12) while the problem persists.
- **"Pipeline healthy"** — the weekly all-clear
  (`heartbeat.all_clear_interval_hours`, 168). Its job is to make an
  empty inbox mean something. Which leads to the important case:

**No mail for over a week is itself the alarm.** It means either the
scheduler machine isn't ticking or the heartbeat stage is failing before
it can send. Check, in order:

```sh
bun run cli status                      # last success per stage
fly machine list -a blurpadurp          # is the scheduler machine alive?
fly logs -a blurpadurp | grep heartbeat
```

`heartbeat` appears in its own digest, so a heartbeat that ran but
couldn't mail still shows up in `pipeline_run` with `status = 'error'`.
A heartbeat that never ran shows as `never` under last success.

**What each problem line wants from you:**

| Line | Action |
|---|---|
| `draft #N is …h old, past the …h staleness ceiling` | The sweep is deliberately refusing to send it (#5b). Publish it knowingly, or Discard — compose is blocked until you do. |
| `draft #N … on hold` | Someone (or the sweep) parked it. `/admin/review` → clear the hold, or Discard. |
| `<stage> has not succeeded since …` | #1–#7 by stage. `bun run cli status` for the full error. |
| `database is … of a … budget` | #14. Check `auto_fix_jsonb` growth first, and remember Neon counts branch history — logical deletes don't shrink it until history rolls. |
| `today's AI spend … cap` | #1. |

**Tuning the noise.** Every threshold is config, not code:
`heartbeat.alert_interval_hours`, `heartbeat.all_clear_interval_hours`,
`storage.db_budget_mb`, `budget.daily_usd_cap`. Raise the intervals if
the mail gets ignorable. **Don't turn the all-clear off** — an alerts-only
monitor cannot distinguish a healthy pipeline from a dead monitor, which
is the failure mode this whole stage exists to prevent. If it's genuinely
too noisy, the honest fix is a wider `STALL_MULTIPLE` in
`src/shared/pipeline-health.ts`, which is one number with a test on it.

**Prevention:** this is the generalisation of #5b and #14 — both were
silent for weeks because nothing was watching a number that was already
in the database. Anything new that can wedge the pipeline without
throwing belongs in `findProblems`, which is pure and takes a snapshot,
so adding a check is a test and a case, not a new subsystem.

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
