# Claude working brief

Context Claude Code needs to be useful in this repo. Not a reference
(the `docs/` folder is the reference). This is the **meta**: what to
not regress, what's opinionated, what keeps biting.

## What this is

Blurpadurp — an automated, anti-algorithm weekly news brief. The whole
product is the filter: ruthlessly selective, silence-is-a-feature,
two-axis (conversational relevance AND durable significance). See
`docs/concept.md`. The publish gate is zeitgeist-based
(`zeitgeist × half_life − non_obviousness`); structural significance
enters at the editor stage — the editor picks within the gated pool
using an explicit four-quadrant rubric (loud×significant, quiet×
significant, loud×insignificant, quiet×insignificant; see
`docs/editor-prompt.md`).

The stack: Bun + Hono + Kysely + Postgres/pgvector + Anthropic +
Voyage. TypeScript throughout. JSX server-rendered (no client JS
unless a feature genuinely needs it). Architecture in
`docs/architecture.md`.

## Pipeline shape

```
ingest → score → editor → compose → autopublish → dispatch → retention
                                                          → heartbeat
```

Seven scheduled stages, run hourly by `scheduler.ts` against the
`pipeline_schedule` table (mig 039). Each acquires a DB mutex
(`pipeline_lock`, mig 024) so manual + cron triggers can't collide.

Most stages fire on `interval_sec` since their last success. **compose
is different**: it's anchored to a calendar slot (`cron_dow` +
`cron_hour`, mig 066) — Saturday 06:00 UTC — because interval
scheduling let the draft day drift a little every week and re-anchored
permanently on any manual trigger. For an anchored stage `interval_sec`
is ignored entirely. Keep `anchoredStageDue` and `nextAnchoredRun`
(both in `scheduler.ts`) in agreement; a "next due" the scheduler skips
is how the drift hid last time.

- **ingest** pulls from connectors (`src/connectors/*.ts`). RSS (16
  newsroom feeds), Reddit r/OutOfTheLoop, GDELT, and Wikipedia (ITN +
  Current Events Portal) are live; see `connectors/registry.ts` for
  the canonical list. GDELT brings regional + multi-language signal
  the curated feeds miss but drags in tabloid/wire noise —
  `source_blocklist` (mig 035) trims at the ingest boundary so
  blocked hosts never spend embedding/scoring credits. Title-regex
  (mig 045) and URL-path (mig 044) filters layer on top. Manage via
  `/admin/sources`, `/admin/title-filters`, `/admin/path-filters`,
  or the "Block source" button on the story drilldown.
- **score** runs the configured LLM on each unscored story via the
  rubric prompt (`docs/scoring-prompt.md`). Currently on DeepSeek
  (mig 049) — cost is no longer the binding constraint. Progressive
  scoring (cheap prefilter → expensive final) is disabled by default
  — flip `scorer.prefilter_model_id` in config to turn on.
- **editor** runs the editor model to curate 12–18 picks from the
  gated pool (`docs/editor-prompt.md`). Sees a pre-computed `themes`
  digest that flags arc candidates structurally, the `narrative_clusters`
  digest (which themes are one running story — mig 075), and
  `recent_coverage` (what the last three issues told the reader).
  Its output is **not** taken as final: `diversifyPicks` applies the
  cluster caps afterwards, because a prompt asking for balance had
  demonstrably not been enough.
- **compose** partitions picks into four fixed sections server-side,
  then runs the composer model to write prose
  (`docs/composer-prompt.md`).
  A **catch-up run** (`compose(retro)`, from `/admin/release` or
  `bun run cli compose --retro`) additionally pulls a bounded set of
  8–21-day-old unpublished stories that the 7-day window would strand.
  These are ranked on `structural_importance × half_life` and **ignore
  `passed_gate`** — the gate is "discussed NOW", so re-ranking old
  stories by composite would just sort them by how loud they were then.
  Don't "simplify" this by widening `COMPOSE_STORY_MAX_AGE_MS`; that
  reintroduces exactly the stale-trending-list failure the split
  avoids. Catch-up items reach the editor flagged `catch_up: true`
  (editor v0.5 tells it to judge them on durability).
- **autopublish** (`src/pipeline/autopublish.ts`) runs hourly and does
  two things: auto-fixes any open draft that is still carrying gloss
  findings (every sweep, up to `compose.auto_fix_max_attempts` lifetime
  recompose attempts per draft — mig 071; a fix is a full recompose, so
  retrying across the 24h window is what makes it converge), and
  publishes drafts past `compose.auto_publish_hours` (24h). A leftover
  gloss finding does **not** block the send as of mig 071
  (`compose.auto_publish_requires_clean` = false): it ships and the
  operator gets a "published with N findings" notice, because holding
  the whole brief over six missing words costs more than the nit. Flip
  that key to `true` to restore the hold. There is also a **staleness
  ceiling**
  (`compose.auto_publish_max_age_hours`, 72h, mig 068): past it a draft
  is held rather than sent, whatever the checker says. A brief is a
  snapshot of its week, so a stale one ships the wrong lead *and* burns
  every story it holds. `autopublishDecision` is the pure predicate. This stage is also why the open-draft stall can't recur:
  `runCompose` bails while any draft exists, so one forgotten draft
  used to silently block every compose behind it.
- **dispatch** is live (`src/pipeline/dispatch.ts`). Email send via
  Resend; per-(issue, subscription) at-most-once enforced by the
  `dispatch_log` unique constraint. Runs every 6h (mig 053), so
  `publishDraft` queues a dispatch force-run — publishing puts the
  issue on the web instantly and the mail would otherwise trail it by
  up to six hours, which is indistinguishable from a broken sweep.
  From header is `FROM_NAME <FROM_EMAIL>` (`formatFrom`); a bare
  address shows as "brief" in every inbox list. Web-push is stubbed. The Resend
  webhook (`/webhooks/resend`) handles bounces/complaints and
  auto-unsubscribes hard failures. Design + send-window logic in
  `docs/dispatch.md`.
- **retention** runs daily — prunes unconfirmed subs, anonymizes
  long-unsubscribed rows, trims old `dispatch_log` entries, ages out cold
  embeddings, **deletes unscored noise stories** past
  `retention.unscored_noise_days` (mig 074), and offloads cold payloads
  to R2 (`src/pipeline/retention.ts`). GDPR storage-limitation policy
  plus the two storage levers. The offload step is gated on
  `storage.cold_tier`, which mig 057 ships **false** — so on a project
  that never flipped it, the tiering `docs/storage.md` describes has
  never actually run. Check that before concluding storage growth is a
  bug.
- **heartbeat** runs every 6h, last in the tick so its digest reports
  the state the tick *left* (`src/pipeline/heartbeat.ts`, mig 078). It
  watches the failures that never throw — a stage outside its cadence,
  a draft parked past the staleness ceiling, spend against the cap,
  `pg_database_size` against `storage.db_budget_mb` — and mails the
  operator. Two rules, both in the pure `heartbeatDecision`: a problem
  mails at most every `heartbeat.alert_interval_hours` (12), and a
  *healthy* pipeline still mails every
  `heartbeat.all_clear_interval_hours` (168). **Don't drop the
  all-clear to cut noise** — without it an empty inbox means both
  "fine" and "the monitor died too", which is the exact ambiguity this
  stage exists to remove. Stage stall thresholds are 3× cadence, and
  anchored compose is measured against a week, not its ignored
  `interval_sec`.

Beyond the scheduled stages, `src/pipeline/` also holds:
`urgent.ts` (event-driven mid-cycle publish), `eval.ts` (human-label
calibration set surfaced at `/admin/eval`), `draft.ts` (admin draft
publish/discard/recompose plumbing), `fixture.ts` (capture/replay
harness), `reattach.ts` / `retag.ts` (theme assignment rebuilds),
`reembed.ts` (embedding-model swap), `reset-publish.ts` (the
"republish this issue" cheat hatch).

## Invariants — do not regress

1. **Silence is a feature.** If nothing clears the gate, no issue.
   Empty sections are omitted, never filled with placeholder text.
2. **The composer does not decide section placement.** compose.ts
   pre-sorts into `conversation[]`, `worth_knowing[]`,
   `worth_watching[]`, `shrug[]` — composer writes prose per
   section. Hard structure beats prompt instructions.
3. **Every scored item is persisted forever.** `story.raw_input`
   and `story.raw_output` are the replay substrate. Never delete.
4. **No accounts.** Subscription is the identity. Magic-link tokens
   via `BLURPADURP_TOKEN_SECRET`. No password field anywhere.
5. **Opinionated on what matters, neutral on how to interpret it.**
   Composer gives context, not conclusions. See `docs/concept.md`.
6. **Prompts are version-bumped via config migration.** File header
   + `config.scorer.prompt_version` / `composer.prompt_version` /
   `editor.prompt_version` must match. Cache is keyed on version.
   The admin `/admin/prompts` page can stage a composer/editor prompt
   in the `prompt_draft` table, but this **only** affects draft
   Re-compose / Re-edit actions — the scheduled pipeline always reads
   `docs/*-prompt.md`. Export-to-file + git commit is still the only
   path to live prompt changes.
7. **Hard prohibitions in the scorer are load-bearing.** Don't
   weaken the "no hindsight" / "no invented justifications" rules
   in `docs/scoring-prompt.md` without replacing them with
   something equally strict.

## Editorial taste (the north)

Register: wry, dry, observant. A sharp-eyed friend, not a wire
service. Register is consistent across hard news and cultural items
— understatement, not section-by-section tone toggle. Think *The
Economist*'s Espresso or Matt Levine's Money Stuff. See the gold
examples in `docs/composer-prompt.md#gold-examples`.

**Recurring voice failures** (all of these are banned in the prompt;
if they reappear it's a tuning regression):

- TOC energy in the opener: "threads to track," "arcs worth
  following," "N things to know"
- Meta-framing in Worth watching: "the signal to watch is…,"
  "watch whether…," "the question is whether…"
- Cross-story bridging: "SpaceX is doing X while Musk is
  simultaneously doing Y" when X and Y come from different
  source articles. Source-fidelity guard in the prompt.
- Reader-guide openers: "Let's start with…," "We'll cover…"
- Source citations as plain text instead of markdown links.
- Stacked-clause sentences past the 30-word cap — three
  threads pretending to be one with em-dashes ("At $126,
  the standoff has fractured OPEC — the UAE quit after 59
  years — triggered a food warning…").
- Bare acronyms with no gloss (VRA, ICC, IRGC, EMA, OPEC), and
  bare specialist names the regex can't catch (Brent, gilt,
  tirzepatide). Universal acronyms only — US, UK, EU, NATO, AI,
  FBI, GDP — go bare; everything else gets a six-word gloss on
  first use. Backstopped mechanically: `gloss-lint.ts` flags
  un-glossed acronyms + curated jargon on the draft-review page
  (it's prompt + linter, since the prompt alone misses one or
  two per issue).
- Telegraphic headline fragments ("Third attempt, charges
  filed, officer shot."). Brief is prose, not chyron.
- Detail-before-meaning leads: opening with what happened
  before what it means. The first sentence carries
  significance; the second carries evidence.
- **One shrug sentence, five times.** Worth a shrug's live
  failure is shape, not register: `{name} did {thing} — which
  is the kind of story that {generates a cycle} and then
  {decays}`, item after item. Two of the prompt's five target
  moves apply to literally anything, so the model reaches for
  those two every week. Composer v0.12 makes the **flat report
  the default move** — state what happened and stop, the tag is
  already the verdict — and rations the trailing clause: at
  most two per section, each punchline move once per issue,
  three of five items flat, two under 15 words. The
  "which is the kind of thing that…" / "forgotten by {weekday}"
  family is banned in every phrasing, not just the listed ones:
  a clause that could move to a different shrug item unchanged
  is filler, not an observation. Shrug lines must also never
  mention the brief's own structure ("this also appears in the
  conversation section above").

**Observed wins to preserve:**

- Closing observation per Worth knowing item
  ("That's replicable in every state," "unthinkable five years
  ago"). Pattern works; gold examples teach it.
- Anti-FOMO framing: "the story getting less attention than it
  deserves," "covered on page four of most papers." This is the
  editorial point of view.

## Observed scorer distribution

Rough from one real pipeline run: **~15 low / ~95 high / rest
medium**. This shapes partition choices:

- Worth watching **cannot** be gated on `confidence ∈ {low, medium}`
  — medium is the scorer's default, so everything would end up
  there. compose.ts uses rank-based routing with a low-confidence
  override, not a confidence-primary rule.
- Scorer is overconfident as a distribution. A future prompt rev
  could relax that, but right now the editor/composer assume
  confidence is weak signal.

## Known failure modes + where they're handled

| Failure | Where fixed | File |
|---|---|---|
| Composer leaves an acronym/jargon un-glossed on first use (slips past the prompt one or two per issue) | Two detection layers, neither blocking: (1) deterministic linter — acronym regex + curated `gloss_term` list (mig 062), zero-cost recall floor, hit-bumped at compose, managed at `/admin/gloss-terms`; (2) `checker` (Haiku, task-tagged so future review tasks bolt on) — catches the un-listed long tail + judges gloss adequacy, grounded on the deterministic findings, persisted on `issue.check_jsonb` (mig 064). **Fixing is fully automatic and ungated.** The autopublish sweep calls `autoFixDraft` every hour while a draft still has findings, up to `compose.auto_fix_max_attempts` (6) lifetime recompose attempts; each run applies up to `compose.auto_fix_max_passes` (2) check→fix→re-check rounds **directly to the draft**. A pass is *adopted* only if it strictly reduces the finding count, and the loop keeps the **best-so-far** across passes rather than stopping at the first non-improvement (a "fix" is a full recompose, so one unlucky roll used to end the run on the original prose). Any re-compose/edit nulls `check_jsonb` **and** `auto_fix_jsonb`, the latter re-arming the sweep | `src/shared/gloss-lint.ts`, `src/ai/checker.ts`, `src/shared/auto-fix.ts` |
| An hourly stage that rewrites a row is a **storage leak on Neon**, not just wasted writes — reported storage includes branch history for the PITR window, so an hourly rewrite of a TOASTed jsonb column is retained hourly even though the logical table never grows. mig 071's retry loop + mig 072's `original_markdown` hit this: two early-exit paths didn't increment the attempt counter, `shouldRetryAutoFix` reads `outcome:"failed"` as retryable, and each of those hourly runs rewrote three copies of the brief. Neon filled, writes started failing, and it surfaced as "publish crashes" | mig 073: prose out of `auto_fix_jsonb` (it was already in `ai_call_log`, which is keyed on `input_hash` and cold-tiers to R2 — the right tier), plus a `runs` counter incremented **before** anything can fail, so no per-path accounting bug can produce an unbounded loop. Recovery + the "logical deletes don't shrink Neon until history rolls" trap are runbook #14 | `src/shared/auto-fix.ts`, `src/shared/check-schema.ts`, `docs/runbook.md` |
| The fix gate became worse than no gate. The propose→preview→accept path (mig 065) was a human approving each recompose — but once the sweep started retrying hourly (mig 071), an adopted automatic pass cleared the pending proposal, so a candidate the operator was reading got wiped and Accept failed with "no proposal". It also gated nothing the loop wasn't already enforcing, and on a hands-off schedule the latency meant the brief sat waiting for an approval nobody was coming to give | Removed (mig 072 drops `fix_candidate_jsonb`). Reviewability moves from **before** the change to **after** it: `auto_fix_jsonb` carries the composer's `original_markdown` + `original_findings`, captured on the first run and never overwritten, and `/admin/review` renders the before/after plus the pass log. Remedies for a fix you dislike are the ordinary ones — Re-compose, edit the body, Discard | `src/shared/auto-fix.ts`, `src/views/admin-review.tsx` |
| Gloss panel cries wolf — the acronym regex flags ubiquitous names (BBC, IBM) and every source-credit link label, so real findings stop being read. Worse, the AI layer quietly overruled them and the page showed both verdicts with equal weight | Four things, mig 070: the code whitelist is a deliberate **superset** of the composer prompt's (over-glossing costs six words, over-flagging costs the operator's trust) and `checker.ts` renders it into its own system prompt so the layers can't drift; acronyms appearing **only** inside markdown link labels aren't uses at all; `gloss_term.is_ignored` is an operator ignore list with a one-click "ignore" button on each finding; and `CheckResult.markdown_sha` lets the panel tell a current AI verdict from a stale one — a current verdict demotes the regex flags it didn't reproduce to an "overruled" fold-out | `src/shared/gloss-lint.ts`, `src/shared/check-schema.ts` |
| "Re-generate fix" is a guaranteed no-op — the composer is cached on a hash of its rendered input, so the same findings produced the byte-identical brief straight out of `ai_call_log` and nothing on the page moved | The attempt number is rendered into the revision notes (`findingsToNotes(findings, attempt)`), which both breaks the hash and tells the composer something true: the last try didn't land. Persisted on `FixCandidate.attempt`, so each manual re-generate counts up. `/admin/review/:id/auto-fix` re-runs the whole automatic loop on demand — the hourly sweep deliberately won't (a composer call an hour), which had left no way to say "try again" | `src/shared/auto-fix.ts`, `src/api/admin.tsx` |
| A stage fails on the hourly tick and **nobody hears about it**. The scheduler was already correct about retrying — due-ness reads `last_success_at`, so a failing stage stays due rather than silently advancing — but the human-facing half was a `console.error` on a machine that suspends between ticks. And the failures that hurt most here don't throw at all: a stage that stops being scheduled, a draft past the staleness ceiling, storage creeping toward the free-tier wall (which surfaced as "publish crashes"). For a product whose correct output is sometimes *nothing*, a jammed pipeline and a quiet week are the same observation | Two channels, both plain email through the existing `notifyAdmin`. (1) The scheduler's catch block mails on a throw, rate-limited by **consecutive-failure count** — powers of two, so 1/2/4/8… A count, not a clock, because each tick is a fresh `scheduler-tick` process and `notifyAdmin`'s dedup map is in-memory and always empty on arrival. (2) The `heartbeat` stage digests everything that never throws. Both decisions are pure functions (`shouldNotifyFailure`, `heartbeatDecision`, `findProblems`) with the DB reads next door in `pipeline-heartbeat.ts` | `src/shared/pipeline-health.ts`, `src/pipeline/heartbeat.ts`, `src/scheduler.ts` |
| Operator can't tell a blocked pipeline from a quiet week, and can't drive a release from the web (every parameterized op was CLI-only because `pipeline_force_run` had nowhere to put an argument) | `/admin/release`: blockers (open draft, lock, cadence gap, next anchored compose), unpublished-backlog counts by age band with the stranded bands flagged, and a catch-up picker. `pipeline_force_run.args` (mig 067) carries stage parameters, so `/admin/run/:stage` can finally say *how* to run, not just *that* it should | `src/views/admin-release.tsx`, `src/api/admin.tsx` |
| One forgotten draft silently stalls the whole pipeline (`runCompose` bails while any `is_draft` row exists, so every later compose no-ops with only a log line — this ate three weeks of briefs once, and a blocked pipeline looked exactly like a quiet one) | The autopublish sweep: a draft that can't sit forever can't block forever. Backed by the `/admin/review` banner, which states the actual publish time for an open draft instead of leaving the deadline implicit | `src/pipeline/autopublish.ts`, `src/views/admin-review.tsx` |
| A reviewer added after the draft sweep (or one whose send errored) never gets the draft — the sweep's `NOT EXISTS` checks only that a `dispatch_log` row exists, not that it succeeded | "Send draft to reviewers" on `/admin/review/:id` → `resendDraftToReviewers`, which targets reviewers with no *settled* send. `DRAFT_SEND_SETTLED` must list statuses from **both** writers — the dispatch stage (`sent`/`noop`) and the Resend webhook (`delivered`/`delayed`), which rewrites rows by `provider_message_id`. Omitting the webhook's pair re-mails everyone whose delivery was confirmed | `src/pipeline/dispatch.ts`, `src/pipeline/dispatch-resend.test.ts` |
| Discarding a draft that reviewers were emailed fails on `dispatch_log_issue_id_fkey` — and discard is the *recovery* path for a stalled pipeline, so the blockage becomes unclearable | `discardDraft` drops the draft's `dispatch_log` rows in the same transaction, behind an `EXISTS (… is_draft)` guard so a wrong id can't wipe a published issue's audit trail. `dispatch_log.issue_id` has no `ON DELETE CASCADE`, unlike `issue_pick`/`issue_annotation` | `src/pipeline/draft.ts`, `test/integration/discard-draft.test.ts` |
| One narrative saturates the brief. A dominant story doesn't arrive as one theme — "US–Iran escalation", "Hormuz shipping" and "oil price spike" are three themes by every measure the system had, all legitimately high-composite, and one piece of news to the reader. Nothing capped that, so an entire conversation section shipped as the same story told four ways | Themes are clustered one level up by centroid cosine (0.72 — deliberately between the 0.70 story→theme attach bar and the 0.85 theme→theme **merge** bar, so clusters group without merging; complete linkage, so a bridge theme can't chain two unrelated narratives). The fix is **placement, not exclusion**: `compose.max_per_section_per_cluster` (1) gives a narrative one slot per section and pushes its surplus **down** into the next one — one item up top and one in Worth knowing reads as a story the brief is following, five up top reads as a brief with one subject, and the cluster's best-ranked pick still leads either way. `compose.max_picks_per_cluster` (4) is a whole-issue backstop that cuts, because Worth watching is an unbounded tail and a nine-story cluster would otherwise ride the spread down and ship seven one-liners on one subject; `editor.pool_max_cluster_fraction` caps admission before the editor ever sees it. Those cuts used to shorten the issue, justified by invariant 1 — **wrong invariant**: silence is about a week with nothing worth saying, and this pool is never that thin. What it actually did was kill Worth watching on exactly the weeks the caps fire. The editor is now asked for 12–18 against `compose.max_issue_picks` (15), so the tail ranks are a reserve the cut spends and a dropped pick costs a slot, not a section. The synthesis opener groups by cluster too, or the one paragraph everyone reads names the same news three ways. Sections are fixed-size (rank-based routing), so a section that can't be filled under the cap is filled over it rather than left short; `diversifyPicks` reports those as a **count**, not a flag, because two five-wide sections need ten picks and the editor targets 10–15 — one or two over-cap placements is an ordinary week, and only a count near the issue size means the week really was one story | `src/shared/theme-cluster.ts`, `src/pipeline/compose-diversity.ts`, mig 075 |
| The brief had no memory of itself. Per theme it knew a count (`n_prior_publications`) and a timeline of story one-liners — neither answers "have we already told the reader this?" — so a running story got re-picked and re-explained week after week, each issue defensible and the sequence repetitive | `loadRecentCoverage` reads the last `compose.recent_coverage_issues` (3) published issues out of `issue_pick`, which has recorded (issue, story, section, rank) all along — no new write path. Editor gets `recent_coverage` plus per-theme `recent_issue_count` / `last_covered_summary`; composer gets `recent_issues` (what each issue led on and already told). Note the limit: it carries the scorer's one-liner, not the prose the reader actually read, so it answers "did we cover this?" and not "did we already make this exact observation?" | `src/shared/recent-coverage.ts`, mig 075 |
| Worth a shrug ships five rows tagged "48-hour controversy", and a composer reading five identical labels writes five identically-shaped jokes. Not a prompt failure — a **selection** one: candidates were ranked by `source_count` ("how hard did the algorithm push this"), and `controversy_flash` is by definition the marker of a story the wires piled onto, so the ranking was very nearly a `controversy_flash` sort. `in_circle_hype` — a niche launch two trade outlets carried — could never win that race | The five slots are spent round-robin across the qualifying penalty factors, `source_count` ranking *within* a factor, and the chosen tag ships as a pre-computed `label` on the row rather than a menu the composer picks from (invariant #2 again). A week where every candidate really is `controversy_flash` still gets five of them — the ranking no longer manufactures that, but it won't hide it either | `src/pipeline/compose-shrug.ts` |
| Worth watching and Worth a shrug shipped with no sources — the prompt read their short-line ceilings as excluding citations (the ceiling is about prose; a citation cluster isn't prose), and treated a dismissal as somehow not a claim | Composer v0.12: **every item in every section cites**, with the domain cap tightening as the item shortens — conversation/Worth knowing 3, Worth watching 2, shrug exactly 1 — so a one-liner doesn't vanish behind a stack of links. In shrug the cluster sits between the sentence and the label, so the tag stays the last thing read. No input change was needed: `source_url` was always rendered | `docs/composer-prompt.md` |
| Same story appears in consecutive issues | `persistIssue` flips `published_to_reader = true` | `src/pipeline/compose.ts` |
| Shrug items recur across runs | Shrug IDs included in the published-set | `src/pipeline/compose.ts` |
| Basic-auth 401 swallowed as branded 500 | `app.onError` re-raises `HTTPException` | `src/api/index.tsx` |
| Runaway scorer cost | `checkBudget()` at top of each Anthropic stage | `src/ai/budget.ts` |
| Pipeline pool drains on re-compose | Composer-replay harness (doesn't touch DB) | `bun run cli composer-replay …` |
| Neon CU climbing from `/health` probe storm | `/health` is DB-less (process-alive only). DB-backed freshness payload lives at `/status` for external monitors; `/admin/status` for the operator. Freshness-query indexes from mig 051. | `src/api/index.tsx`, `fly.toml`, `src/api/status.ts` |
| Neon woken by crawler/reader traffic on public pages | Public read pages (`/`, `/archive`, `/about`, `/privacy`, `/feed.xml`, `/sitemap.xml`, `/issue/:id`) served from the R2 page cache (TTL + bust on publish), not the DB. App machine autostops, so the cache must be out-of-process (R2). `/about` and `/privacy` are effectively static — the Hono routes still exist as a fallback for direct-to-origin probes, but the Worker serves the R2 copy first. | `src/shared/page-cache.ts`, `src/pipeline/draft.ts` |
| Fly machine wakes on a reader visit *despite* the R2 edge | The HTML was edge-served, but its same-origin sub-resources weren't: `/assets/*` (brand mark, `wave.js`) + the `/favicon.ico` probe fell through the Worker's key map → proxied to Fly. Both are edge-served now. The `<link rel="icon">` tag in the layout helps well-behaved browsers but crawlers and older clients still probe `/favicon.ico` directly, so the manifest aliases it onto `assets/blurp.svg` to keep that probe off the origin. | `infra/worker/src/index.ts`, `src/pipeline/static-export.tsx`, `src/views/layout.tsx` |
| The path→key map existed twice — the export chose keys, the Worker re-derived them from the request path, and a comment on each side asked the next person to keep them in agreement. It drifted twice: `/assets/*` was added to the export only (the row above), and the Worker's `keyFor` was renamed to `pageTarget`/`assetTarget` while all three comments kept pointing at the old name. Nothing at runtime connected the two, so drift showed up as reader traffic quietly waking Fly | The export publishes its own map: `manifest.json`, written into the bucket **last** (after every body is in place) and re-read by the Worker per isolate on a 60s TTL. The Worker holds no routes at all, so adding a page/locale/asset is a one-sided change — which also dodges `worker-deploy.yml` only firing on `infra/worker/**`. No manifest = no routes = everything proxies to origin, the same Tier-0 degradation as an empty bucket (`bun run cli static-export` populates it without waiting for a publish). Worker routing lives in a Cloudflare-type-free `routes.ts` **so the app's tests can import the real resolver** and run it over the real export output — the old guard could only regex the locale list out of the Worker's source | `src/shared/static-manifest.ts`, `infra/worker/src/routes.ts`, `src/pipeline/static-export.tsx` |
| `src/db/schema.ts` is hand-maintained against 77 migrations ("keep in sync by hand"). Drift is silent in the direction that matters: a migration adds or renames a column, the Kysely types don't know, and every query still type-checks while lying about what comes back | `test/integration/schema-drift.test.ts` diffs the declared `Database` interface against `information_schema` on the migrated test database — tables, columns, nullability, base type, and `Generated<>` on a column with no default. Costs nothing to run: the integration job already stands up Postgres and applies every migration. `numeric` maps to `string` on purpose (node-postgres doesn't parse numerics into JS numbers) | `test/integration/schema-drift.test.ts` |
| Site 5xx + monitor alert during cold start (single autostopping machine races its own stop: "machine still active, refusing to start") | Stay scale-to-zero (min = 0) but soften: `auto_stop_machines = "suspend"` (resume from RAM) + 15s health-check interval so a failed post-boot check re-probes fast. Self-heals; runbook #13. Do NOT "fix" the adjacent pg sslmode warning by pinning verify-full — it breaks the Neon handshake (runbook #13). | `fly.toml`, `docs/runbook.md` |
| Confirmation-email bombing / domain-reputation abuse via `POST /subscribe` | Three layers: per-recipient `last_confirmation_sent_at` cooldown (mig 061) kills same-address resend; a fixed-key global token bucket caps total outbound confirmations and alerts via `notifyAdmin` on trip; a coarse per-IP limiter wraps the signed-token routes. All throttle paths return the same `subscribed=1` redirect — never leak whether an address exists or was throttled. | `src/api/index.tsx`, `src/shared/rate-limit.ts` |

## Tuning loop

See `docs/tuning.md`. Short version:

1. `docker compose up -d && bun run migrate`
2. `bun run cli ingest && bun run cli score && bun run cli compose` — once.
3. `bun run cli fixture-capture 100` — locks scorer I/O to disk.
4. Edit prompts. Run `composer-replay <issue_id> <prompt> <version> <model>`
   or `fixture-replay` for scorer prompts. Neither touches the DB.
5. Read `fixtures/*.diff.md` in anything that renders markdown.
6. When you like it, bump config versions via a migration and re-run
   compose on fresh data.

## Environment gotchas

- **`GOOGLE_APPLICATION_CREDENTIALS`** needs BigQuery Data Viewer +
  Job User. The GDELT connector hits partitioned tables; the
  partition-pruner fails on `@param` bindings so the connector
  inlines timestamps as literals (see `gdelt.ts` comment).
- **`BLURPADURP_TOKEN_SECRET`** must be set; rotating it
  invalidates outstanding magic links.
- **`ADMIN_PASSWORD`** unset → `/admin/*` returns 503 (safe default).
  Basic-auth realm, no logout button.
- **`BLURPADURP_BLOCK_CRAWLERS=1`** flips robots.txt to Disallow-all
  — for stage-2 hidden deploys.

## Locales

The site chrome is English (unprefixed) + Norwegian bokmål (`/no`).
**The brief body is not translated** — it's composer output, and every
Norwegian page that can show one says so rather than letting the reader
find out. Strings live in `src/shared/i18n.ts`, one typed object per
locale, so a missing key is a compile error. Three things to know before
touching it: locale is never negotiated from `Accept-Language` (reader
pages sit behind an edge cache keyed on path alone, so varying by header
hands the wrong language to whoever asks second); the R2 key map is
authored once in `static-export.tsx` and published to the edge as
`manifest.json`, so a new locale is a change there alone (the Worker
needs no deploy); and a subscriber's language lives on their row
(mig 076) because a link clicked from an inbox has no URL to recover it
from. See `docs/i18n.md`.

## When in doubt

- Reads can be served entirely from the edge: a Cloudflare Worker
  serves the pre-rendered pages **and their `/assets/*`
  sub-resources** from a public R2 bucket and proxies the
  dynamic/write trickle to Fly. (Serving assets is load-bearing —
  miss them and the browser wakes Fly fetching the logo/favicon
  off the R2-served HTML.) The publish-time export owns the path→key
  map (`src/pipeline/static-export.tsx`) and publishes it as
  `manifest.json`; the Worker reads that and holds no routes of its
  own. Opt-in via `R2_PUBLIC_BUCKET` — no-op until set. See
  `docs/scaling.md`.
- Don't add a new AI stage. Prefer hard structure in TypeScript.
- Don't hot-patch prompts in production. Capture → replay → bump
  version → commit.
- Don't delete `ai_call_log` rows. They are training data for the
  eventual surrogate classifier and the drift-detection substrate.
- Silence is the correct response to a weak week. Don't lower the
  gate to fill column inches.
- Production runs on Neon's free tier. CU is the cost driver and
  the DB needs to actually scale-to-zero (~5 min idle timeout) to
  stay within budget. `/health` is DB-less by design — don't add
  DB calls to it. DB-backed freshness lives at `/status`
  (lower-frequency external monitors) and `/admin/status` (HTML).
  Don't add an unbounded scan to any frequently-hit path without
  an index.
- Storage budget (free tier ~500 MB) is tiered, not flat. Embeddings
  are `halfvec` and derived (reembed.ts rebuilds them) — they are NOT
  persist-forever; old individual `story.embedding` rows are aged out
  daily by retention. The persist-forever invariant covers
  `raw_input`/`raw_output` (and `ai_call_log`) only. The hot scoring
  path reads `story.scorer_summary`, not `raw_output`, so the bulky
  payloads are cold-storage-eligible. See `docs/storage.md`.

## File map (navigation)

- Product intent: `docs/concept.md`
- Pipeline: `docs/architecture.md`
- Scorer rubric + prompt: `docs/scoring.md`, `docs/scoring-prompt.md`
- Editor curation rules + prompt: `docs/editor-prompt.md`
- Composer voice + sections + gold examples: `docs/composer-prompt.md`
- Narrative clustering + diversity caps: `src/shared/theme-cluster.ts` (maths), `src/shared/theme-cluster-store.ts` (centroid load), `src/pipeline/compose-diversity.ts` (caps)
- Shrug slot allocation + labels: `src/pipeline/compose-shrug.ts`
- Prior-issue memory: `src/shared/recent-coverage.ts`
- Draft checker (gloss first-use today; task-tagged for more later): deterministic `src/shared/gloss-lint.ts` + LLM `src/ai/checker.ts`, types in `src/shared/check-schema.ts`, automatic fix loop in `src/shared/auto-fix.ts`
- Dispatch design + live behavior: `docs/dispatch.md`
- Storage tiering + cold-storage plan: `docs/storage.md`
- Scaling reads (edge Worker + static export to R2): `docs/scaling.md`
- Locales (site chrome EN + NB; the brief is NOT translated): `docs/i18n.md`
- Backtesting methodology: `docs/backtesting.md`
- Runbook for failure triage: `docs/runbook.md`
- Tuning loop: `docs/tuning.md`
- Deploy recipe: `docs/deploy.md`
