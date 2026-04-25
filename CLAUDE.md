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
ingest → score → editor → compose → (dispatch)
```

- **ingest** pulls from connectors (`src/connectors/*.ts`). RSS (16
  newsroom feeds) and Reddit r/OutOfTheLoop are live. GDELT was
  deregistered — too much tabloid/foreign-language noise to be worth
  the filtering cost. Connector file is preserved if you want to
  revisit.
- **score** runs Haiku on each unscored story via a rubric prompt
  (`docs/scoring-prompt.md`). Gate is mechanical, not AI.
  Progressive scoring (cheap prefilter → expensive final) is
  disabled by default — flip `scorer.prefilter_model_id` in config
  to turn on.
- **editor** runs Sonnet to curate 10–15 picks from the gated pool
  (`docs/editor-prompt.md`). Sees a pre-computed `themes` digest
  that flags arc candidates structurally.
- **compose** partitions picks into four fixed sections server-side,
  then runs Sonnet to write prose (`docs/composer-prompt.md`).
- **dispatch** is stubbed. Design in `docs/dispatch.md`.

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
| Same story appears in consecutive issues | `persistIssue` flips `published_to_reader = true` | `src/pipeline/compose.ts` |
| Shrug items recur across runs | Shrug IDs included in the published-set | `src/pipeline/compose.ts` |
| Basic-auth 401 swallowed as branded 500 | `app.onError` re-raises `HTTPException` | `src/api/index.tsx` |
| Runaway scorer cost | `checkBudget()` at top of each Anthropic stage | `src/ai/budget.ts` |
| Pipeline pool drains on re-compose | Composer-replay harness (doesn't touch DB) | `bun run cli composer-replay …` |

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

- Don't add a new AI stage. Prefer hard structure in TypeScript.
- Don't hot-patch prompts in production. Capture → replay → bump
  version → commit.
- Don't delete `ai_call_log` rows. They are training data for the
  eventual surrogate classifier and the drift-detection substrate.
- Silence is the correct response to a weak week. Don't lower the
  gate to fill column inches.

## File map (navigation)

- Product intent: `docs/concept.md`
- Pipeline: `docs/architecture.md`
- Scorer rubric + prompt: `docs/scoring.md`, `docs/scoring-prompt.md`
- Editor curation rules + prompt: `docs/editor-prompt.md`
- Composer voice + sections + gold examples: `docs/composer-prompt.md`
- Dispatch design (not yet implemented): `docs/dispatch.md`
- Backtesting methodology: `docs/backtesting.md`
- Runbook for failure triage: `docs/runbook.md`
- Tuning loop: `docs/tuning.md`
- Deploy recipe: `docs/deploy.md`
