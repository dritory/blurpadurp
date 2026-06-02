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
4. **Cold tier (R2) — future:** move `raw_input`/`raw_output` bulk and
   `ai_call_log` payloads to object storage, keyed by `input_hash`,
   stored once and referenced by both `story` and `ai_call_log`.
   Persist-forever satisfied — just not in Neon. Prereq landed: the
   hot path no longer touches `raw_output` (it reads
   `story.scorer_summary`), so `raw_output` can move without affecting
   scoring. See "Cold tier design" below before building.

Steps 2–3 are in-Postgres and reversible, and target the largest
(vectors) and fastest-growing (old embeddings + `ai_call_log`) lines.
They should clear the immediate crunch, leaving the R2 build (4) as a
considered project rather than a fire drill.

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

### Phase 1 — `ai_call_log` payloads (shipped, flag-gated)

`ai_call_log` is the fastest grower and its payloads are purely cold
(read only by within-run idempotency + admin). Implemented in
`src/ai/log.ts` (the single choke point all AI stages funnel through):

- **Key:** `ai/{stage}/{yyyy}/{mm}/{uuid}.json` holding
  `{"input":..,"output":..}`. Not content-addressed — scorer inputs are
  near-unique, so dedup buys little; the month prefix enables cheap R2
  lifecycle rules / browsing.
- **Write:** when `storage.cold_tier` config is `true`, `logAICall`
  writes the payload to the store and inserts the row with
  `payload_key` set and `*_jsonb` NULL. A store failure falls back to
  inline jsonb — a record is never lost over a storage hiccup.
- **Read:** `findCachedOutput` fetches by `payload_key` when set, else
  the inline `output_jsonb`. A store miss returns null = "no cache" =
  re-run the model (safe degradation).
- **Backfill:** `bun run cli cold-migrate [batchSize] [maxBatches]`
  relocates existing inline payloads in bounded, resumable batches.
  Order is write-object-then-null-row, so a crash orphans an object at
  worst, never dangles a row.

**Rollout:** (1) provision R2 + set env; (2) `bun run migrate`
(mig 057 adds `payload_key` + the `storage.cold_tier=false` flag);
(3) flip `storage.cold_tier` to `true` so *new* calls offload; (4) run
`cold-migrate` to move the backlog; (5) `VACUUM (FULL) ai_call_log` to
hand the freed pages back to Neon. The column + plumbing are inert
until step 3, so 057 is safe to ship ahead of R2 setup.

### Phase 2 — `story.raw_input`/`raw_output` (designed, not built)

Same store, same pattern. The hot path already reads
`story.scorer_summary` (mig 055), so `raw_*` are cold. Add
`story.payload_key`, offload at `persistScorerResult`, and have
`fixture-capture` + the admin drilldown read through the store.

### Phase 3 — rolling-window row eviction (for true indefinite bound)

Even with payloads in R2, the *scalar* rows (`story`, `ai_call_log`)
grow linearly. For a hard bound, retention evicts rows past a long
window once their payload is safely in R2 — keeping a bounded hot set
while R2 stays the complete archive. Size the window from the
growth-rate query in this doc once measured. Watch references before
deleting `story` rows: `story_factor`/`eval_label`/`ground_truth`/
`issue_pick` cascade; `issue.story_ids` is a bare array (dangling ids
in historical issues are cosmetic — the prose is already in
`composed_markdown`).

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
