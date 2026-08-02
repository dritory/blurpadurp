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
```

Six scheduled stages, run hourly by `scheduler.ts` against the
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
- **editor** runs the editor model to curate 10–15 picks from the
  gated pool (`docs/editor-prompt.md`). Sees a pre-computed `themes`
  digest that flags arc candidates structurally.
- **compose** partitions picks into four fixed sections server-side,
  then runs the composer model to write prose
  (`docs/composer-prompt.md`).
- **autopublish** (`src/pipeline/autopublish.ts`) runs hourly and does
  two things: auto-fixes any open draft that hasn't been through the
  checker yet (so the draft you open is already glossed), and publishes
  drafts past `compose.auto_publish_hours` (24h). A draft that reaches
  its deadline still failing the checker is **held** (`issue.hold`) and
  the operator notified — email is irreversible, so a late brief beats
  a bad one. This stage is also why the open-draft stall can't recur:
  `runCompose` bails while any draft exists, so one forgotten draft
  used to silently block every compose behind it.
- **dispatch** is live (`src/pipeline/dispatch.ts`). Email send via
  Resend; per-(issue, subscription) at-most-once enforced by the
  `dispatch_log` unique constraint. Web-push is stubbed. The Resend
  webhook (`/webhooks/resend`) handles bounces/complaints and
  auto-unsubscribes hard failures. Design + send-window logic in
  `docs/dispatch.md`.
- **retention** runs daily — prunes unconfirmed subs, anonymizes
  long-unsubscribed rows, trims old `dispatch_log` entries
  (`src/pipeline/retention.ts`). GDPR storage-limitation policy.

Beyond the five scheduled stages, `src/pipeline/` also holds:
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
| Composer leaves an acronym/jargon un-glossed on first use (slips past the prompt one or two per issue) | Two advisory layers on `/admin/review`, both non-blocking: (1) deterministic linter — acronym regex + curated `gloss_term` list (mig 062), zero-cost recall floor, hit-bumped at compose, managed at `/admin/gloss-terms`; (2) on-demand `checker` (Haiku, task-tagged so future review tasks bolt on) the operator triggers per draft — catches the un-listed long tail + judges gloss adequacy, grounded on the deterministic findings, persisted on `issue.check_jsonb` (mig 064). On a draft, "Propose fix" feeds findings back as composer `revision_notes` and re-composes into a **non-destructive candidate** (`issue.fix_candidate_jsonb`, mig 065) — re-checked and previewed inline; the live draft changes only on explicit Accept (Discard drops it). Any re-compose/edit nulls the stale result + pending candidate. **As of mig 066 this runs automatically** — the autopublish sweep calls `autoFixDraft` on any draft with no `auto_fix_jsonb`, applying up to `compose.auto_fix_max_passes` (2) check→fix→re-check rounds directly, with the pre-fix prose kept on `issue.auto_fix_jsonb` for before/after. A pass is accepted only if it strictly *reduces* the finding count, so a thrashing composer can't make the brief worse on the way to its deadline. The manual propose→preview→accept path is unchanged and still there | `src/shared/gloss-lint.ts`, `src/ai/checker.ts`, `src/shared/auto-fix.ts` |
| One forgotten draft silently stalls the whole pipeline (`runCompose` bails while any `is_draft` row exists, so every later compose no-ops with only a log line — this ate three weeks of briefs once, and a blocked pipeline looked exactly like a quiet one) | The autopublish sweep: a draft that can't sit forever can't block forever. Backed by the `/admin/review` banner, which states the actual publish time for an open draft instead of leaving the deadline implicit | `src/pipeline/autopublish.ts`, `src/views/admin-review.tsx` |
| Same story appears in consecutive issues | `persistIssue` flips `published_to_reader = true` | `src/pipeline/compose.ts` |
| Shrug items recur across runs | Shrug IDs included in the published-set | `src/pipeline/compose.ts` |
| Basic-auth 401 swallowed as branded 500 | `app.onError` re-raises `HTTPException` | `src/api/index.tsx` |
| Runaway scorer cost | `checkBudget()` at top of each Anthropic stage | `src/ai/budget.ts` |
| Pipeline pool drains on re-compose | Composer-replay harness (doesn't touch DB) | `bun run cli composer-replay …` |
| Neon CU climbing from `/health` probe storm | `/health` is DB-less (process-alive only). DB-backed freshness payload lives at `/status` for external monitors; `/admin/status` for the operator. Freshness-query indexes from mig 051. | `src/api/index.tsx`, `fly.toml`, `src/api/status.ts` |
| Neon woken by crawler/reader traffic on public pages | Public read pages (`/`, `/archive`, `/about`, `/privacy`, `/feed.xml`, `/sitemap.xml`, `/issue/:id`) served from the R2 page cache (TTL + bust on publish), not the DB. App machine autostops, so the cache must be out-of-process (R2). `/about` and `/privacy` are effectively static — the Hono routes still exist as a fallback for direct-to-origin probes, but the Worker serves the R2 copy first. | `src/shared/page-cache.ts`, `src/pipeline/draft.ts` |
| Fly machine wakes on a reader visit *despite* the R2 edge | The HTML was edge-served, but its same-origin sub-resources weren't: `/assets/*` (brand mark, `wave.js`) + the `/favicon.ico` probe fell through the Worker's `keyFor` → proxied to Fly. Worker now serves `/assets/*` from R2 (`exportPublicAssets` mirrors `./public`). The `<link rel="icon">` tag in the layout helps well-behaved browsers but crawlers and older clients still probe `/favicon.ico` directly, so the Worker also maps `/favicon.ico` → `assets/blurp.svg` to keep that probe off the origin. | `infra/worker/src/index.ts`, `src/pipeline/static-export.tsx`, `src/views/layout.tsx` |
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

## When in doubt

- Reads can be served entirely from the edge: a Cloudflare Worker
  serves the pre-rendered pages **and their `/assets/*`
  sub-resources** from a public R2 bucket and proxies the
  dynamic/write trickle to Fly. (Serving assets is load-bearing —
  miss them and the browser wakes Fly fetching the logo/favicon
  off the R2-served HTML.) Publish-time export +
  path→key map live in `src/pipeline/static-export.tsx` /
  `infra/worker/`; keep the two key maps in sync. Opt-in via
  `R2_PUBLIC_BUCKET` — no-op until set. See `docs/scaling.md`.
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
- Draft checker (gloss first-use today; task-tagged for more later): deterministic `src/shared/gloss-lint.ts` + on-demand LLM `src/ai/checker.ts` (`src/shared/check-schema.ts`)
- Dispatch design + live behavior: `docs/dispatch.md`
- Storage tiering + cold-storage plan: `docs/storage.md`
- Scaling reads (edge Worker + static export to R2): `docs/scaling.md`
- Backtesting methodology: `docs/backtesting.md`
- Runbook for failure triage: `docs/runbook.md`
- Tuning loop: `docs/tuning.md`
- Deploy recipe: `docs/deploy.md`
