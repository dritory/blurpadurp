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

## Cold tier design (not yet built)

When `ai_call_log` growth becomes the binding constraint again:

- **Object key:** `sha256(input)` (already computed as
  `ai_call_log.input_hash`) → `ai/{stage}/{hash}.json`. Identical
  inputs (the scorer dedup case) collapse to one object.
- **Postgres keeps:** the scalar columns + the R2 key. `findCachedOutput`
  becomes an R2 GET on the rare idempotent-retry path (acceptable —
  it runs seconds after the write, within a single pipeline run).
- **`story.raw_input`/`raw_output`:** replace the jsonb with the same
  R2 key. `fixture-capture` fetches from R2; everything else already
  reads `scorer_summary`.
- **Do not** put an R2 GET on any per-story scoring path — only on
  offline tuning (`fixture-capture`) and rare idempotent retries.
- Egress: reads are infrequent and operator-initiated; R2 has no
  egress fees regardless.

## Invariant check

- "Every scored item persisted forever" — intact. `raw_input`/
  `raw_output` are never deleted; halfvec/age-out touch only derived
  vectors; the cold tier relocates payloads, doesn't drop them.
- "Don't delete `ai_call_log` rows" — intact. Cold tier moves the
  payload columns to R2; the rows (and their scalar training signal)
  stay.
