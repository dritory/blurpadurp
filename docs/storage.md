# Storage model

Why the database is big, what each large thing is actually *for*, and
the tiering that follows from that. Written when the DB hit 470/500 MB
on Neon's free tier and the instinct was "it's just text — it
shouldn't be this big." Half of it isn't text.

## The corpus is two different things

Per scored story, storage splits roughly in half:

| | What | Compressible? | Persist-forever? |
|---|---|---|---|
| **Vectors** | `story.embedding`, `theme.centroid_embedding`, their ivfflat indexes | No — high-entropy float data | **No** — derived, see below |
| **Payloads** | `story.raw_input`/`raw_output`, `ai_call_log.*_jsonb` | Yes — 5–10× via TOAST | `raw_*` yes; `ai_call_log` yes |

The "persist forever" invariant (CLAUDE.md #3) covers
`story.raw_input` and `story.raw_output` — the scorer replay
substrate — and `ai_call_log` (training data). **It has never covered
embeddings.** Embeddings are *derived*: `src/pipeline/reembed.ts`
rebuilds every one from `title + scorer_summary`. We were keeping
re-computable scratch in the hottest, most expensive tier as if it
were the archive.

A second waste: the scorer writes the same content **twice** — to
`story.raw_input`/`raw_output` *and* to `ai_call_log.input_jsonb`/
`output_jsonb`. Near-pure duplication for the highest-volume stage.

## When is each piece actually needed?

| Data | Read by | When | Tier |
|---|---|---|---|
| `theme.centroid_embedding` | theme attach/continuation (`score.ts`) | every score cycle | **hot** (tiny — one per theme) |
| `story.embedding` (individual) | near-dup scan (`score.ts:tryInheritFromNeighbor`) | only vs. **incoming** stories, `dedup_lookback_days` = **3 days** | **hot but short-lived** |
| `story.embedding` (individual) | `recomputeThemeCentroid` | only when an **active** theme gains a member | warm (active themes only) |
| `story.scorer_summary` | hot path `loadThemeContext` / theme-continuation | every score cycle | **hot** (denormalized, tiny) |
| `story.raw_output` (bulk) | `fixture-capture`, admin drilldown | offline tuning / manual | **cold-eligible** |
| `story.raw_input` | `fixture-capture` only | offline tuning | **cold-eligible** |
| `ai_call_log.*_jsonb` | `findCachedOutput` (within-run idempotency); admin | seconds after write, then ~never | **cold-eligible** |
| `ai_call_log` cost/token cols | budget guard, cost dashboard | frequent | **hot** (scalars) |

The decisive number: the dedup window is **3 days**
(`scorer.dedup_lookback_days`). An individual story's embedding does
real work for 72 hours, then only matters if its theme is still
actively gaining members. Nothing reads old individual vectors or old
raw payloads in any frequent path — they sit in the hot tier as a
silent archive.

## Tiering

1. **Hot, kept small (Postgres):** scalar scores, `theme.centroid_embedding`,
   recent-window `story.embedding`, `story.scorer_summary`,
   `ai_call_log` scalar cost/token columns.
2. **Shrink what stays hot:** `vector(1024)` (4 B/dim) → `halfvec(1024)`
   (2 B/dim). Halves both the embedding columns and their ivfflat
   indexes. Cosine error from fp16 is ~1e-3 — far below our
   attach/dedup decision margins (0.70 / 0.88 / 0.95). Pure pgvector
   migration, no new infra. **(mig 054, done.)**
3. **Age out + recompute-on-demand:** null `story.embedding` for
   stories outside the dedup window whose theme is dormant. The
   ivfflat index shrinks to the live set as autovacuum reclaims the
   dead entries. `reembed.ts` regenerates any vector if ever needed.
   **(retention stage, done — `retention.embedding_hot_days`,
   default 90, ≫ the 3-day dedup window.)**
4. **Cold tier (R2) — done, flag-gated:** payloads
   (`raw_input`/`raw_output`, `ai_call_log` jsonb) stay inline for a
   14-day window, then retention offloads them to R2 and nulls the
   columns. Rows stay; persist-forever satisfied in R2. See "Cold tier"
   below.

Steps 2–3 are in-Postgres and reversible, and target the largest
(vectors) and fastest-growing (old embeddings + `ai_call_log`) lines.
Step 4 takes the payload mass out of Neon for good.

## Cold tier — R2 is the archive

Decision (operator): "persist forever" means **persist forever in R2**,
not in Neon. Postgres holds a bounded working set + an object key; R2
holds the durable payloads. This is the only design that stays under
500 MB *indefinitely* — anything monotonic in Postgres crosses a fixed
cap eventually.

The object store (`src/shared/object-store.ts`) is one interface with
three backends — `r2` (Bun's built-in S3 client, no dep), `fs` (dev +
tests), `memory` (tests). Backend is chosen by
`BLURPADURP_STORAGE_BACKEND` (default: `r2` when R2 creds are present,
else `fs` under `./.cold-storage`). R2 creds via env: `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`
(`https://<accountid>.r2.cloudflarestorage.com`).

**Rows stay; only payloads move.** We never delete `story` /
`ai_call_log` rows — the scalar columns (scores, theme links, cost,
flags) are small and load-bearing (themes, 30/90-day rolling stats,
`/admin/eval`, issue integrity all depend on them). Only the bulky
jsonb relocates to R2. This bounds the *payload* footprint; the scalar
rows grow slowly (see "True indefinite bound" below).

### Windowed offload (not at write time)

The key design choice: payloads stay **inline in Postgres for
`storage.cold_tier_age_days` (default 14, mig 059)**, then the daily
retention stage offloads anything older to R2 and nulls the columns.

Why a window instead of offloading on write: the only *scheduled*
payload reader is compose's editor/shrug pool, gated to 7-day
freshness (`COMPOSE_STORY_MAX_AGE_MS`). A 14-day inline window means
**no scheduled path ever fetches a payload from R2** — recent rows are
always inline. R2 is touched only by the offload writer (retention),
`fixture-capture` of old data, and admin drilldowns of old items.
(compose's 90-day prior-timeline reads the `scorer_summary` column, not
the payload, precisely so it stays R2-free.)

Steady state needs no repeated `VACUUM FULL`: new inline payloads reuse
the heap/TOAST pages freed when old ones are nulled, so the inline
payload mass stabilizes at ~one window's worth. A one-time
`VACUUM (FULL)` is only for reclaiming the historical backlog after the
first big `cold-migrate`.

### Mechanics

- **Keys:** `ai/{stage}/{yyyy}/{mm}/{uuid}.json` and
  `story/{yyyy}/{mm}/{uuid}.json`, each holding `{"input":..,"output":..}`.
  Month prefix enables cheap R2 lifecycle rules / browsing.
- **Offload engine:** `src/pipeline/cold-migrate.ts` `offloadPayloads({
  olderThanDays })` — bounded, resumable batches, write-object-then-
  null-row (a crash orphans an object at worst, never dangles a row).
  Called by retention (`olderThanDays` = the window) and by
  `bun run cli cold-migrate [batchSize] [maxBatches] [olderThanDays]`
  (`olderThanDays` defaults to 0 = the full historical backfill).
- **Columns:** `ai_call_log.payload_key` (mig 057),
  `story.payload_key` (mig 058). When set, the `*_jsonb` /
  `raw_*` columns are NULL.
- **Reads** fall back to inline whenever `payload_key` is NULL, so
  everything works before/independent of any offload:
  - `findCachedOutput` resolves `output` via the key (rare — idempotent
    retries hit a seconds-old, still-inline row).
  - compose's editor/shrug pools call `hydrateRawOutput()` — a no-op in
    practice (rows ≤7d are inline) but a correct safety net.
  - `fixture-capture`, the admin story drilldown, and `/admin/eval`
    resolve via the key for genuinely old rows.
  - summary-only readers (`reattach`, theme-stories list, compose
    prior-timeline) use the `scorer_summary` column — never a payload.
- **Dedup-inherit:** copies the donor's `payload_key` when set; in
  practice the donor is ≤3 days old (the dedup lookback) so it's always
  inline — the copy carries the inline `raw_output`.

**Rollout:** (1) provision R2 + set env (`docs/deploy.md`);
(2) `bun run migrate` (057/058 add the columns, 059 the window — all
inert while the flag is off); (3) flip `storage.cold_tier=true`;
(4) retention now offloads aged payloads daily; (5) one-time
`bun run cli cold-migrate` to move the historical backlog, then
`VACUUM (FULL) ai_call_log; VACUUM (FULL) story;` to return the freed
pages to Neon.

### True indefinite bound (scalar rows)

Even with payloads in R2, the scalar rows grow linearly (~1.5 KB/story
+ ~0.2 KB/ai-call). At observed volume that's years of headroom, not a
fire. If it ever binds, the next lever is **archiving whole rows** to
R2 past a long window and deleting them from PG — but that must be
reference-aware (`story_factor`/`eval_label`/`ground_truth`/`issue_pick`
cascade; `issue.story_ids` is a bare array; themes and 30/90-day
rolling stats read recent scored rows). Not built; revisit with the
growth-rate numbers.

The live trajectory — database size vs. the 500 MB cap, per-table
footprint, story population (scored/unscored/cold/inline), 30-day
intake, and a rough months-to-cap — is on **`/admin/status`**
(`src/api/storage-status.ts`). Admin-only; never added to `/health` or
`/status`, which stay cheap.

### Non-invariant lever: prune unscored noise rows


### Non-invariant lever: prune unscored noise rows

The biggest row population is stories that never scored (ingest/filter
noise). They carry no persist-forever obligation (the invariant covers
*scored* `raw_*` only), so retention can prune unscored, unreferenced
stories past a short TTL — pure win, no R2, no invariant impact. Sized
from the story-population query above.

## Invariant check

- "Every scored item persisted forever" — intact. `raw_input`/
  `raw_output` are never deleted; halfvec/age-out touch only derived
  vectors; the cold tier relocates payloads, doesn't drop them.
- "Don't delete `ai_call_log` rows" — intact. Cold tier moves the
  payload columns to R2; the rows (and their scalar training signal)
  stay.
