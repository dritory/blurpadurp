// Data retention. GDPR Art. 5(1)(e) expects a defined storage
// limitation — we implement it here as three rules:
//
// 1. Unconfirmed subs older than 30 days → delete the row. They
//    never clicked the confirm link; no lawful basis to retain.
// 2. Unsubscribed subs older than 90 days → null out the email (keep
//    the row as a re-subscribe suppression marker). Email hash would
//    be nicer; not worth the extra dep for our scale. NULL-email rows
//    can still block a re-subscribe by id, though the /subscribe form
//    doesn't currently use that. Over time we can either delete the
//    rows entirely or move to a suppression-list table.
// 3. dispatch_log rows with status = 'noop' or 'delivered' older than
//    180 days → delete. Hard bounce / complaint rows we keep forever
//    (they're the reason we won't resend).
// 4. story.embedding nulled for stories scored more than
//    retention.embedding_hot_days ago whose theme is dormant. See
//    "age-out" note below.
// 5. Unscored, unreferenced story rows older than
//    retention.unscored_noise_days → delete. See "noise prune" below.
//
// Ai_call_log is left untouched — it's training-data substrate per
// CLAUDE.md's invariant ("Don't delete ai_call_log rows").
//
// Noise-prune rationale (docs/storage.md, "Non-invariant lever"): every
// ingest writes a row per item that clears the filters, ~10-15 a week are
// ever published, and a large share are never scored at all. Those rows
// are monotonic and they are what fills a fixed 500 MB. Invariant 3
// covers *scored* raw_input/raw_output; a row with scored_at IS NULL has
// no persist-forever claim, so pruning it is a pure win — no R2 needed,
// unlike the payload tiering in step 6.
//
// The one thing to be careful about is references. issue.story_ids is a
// bare int array with NO foreign key (mig 025 only constrains
// issue_pick), so a cascade would not have caught it — the prune has to
// check it explicitly, and does.
//
// Age-out rationale (docs/storage.md): an individual story's embedding
// does real work only inside the dedup window
// (scorer.dedup_lookback_days = 3 days) and, after that, only while its
// theme keeps gaining members. Beyond that it is dead weight in the
// story_embedding_idx ivfflat index. Embeddings are DERIVED data —
// reembed.ts regenerates any of them from title + scorer_summary — so
// nulling them is not a "persist forever" violation (that invariant
// covers raw_input/raw_output). We only null stories whose theme is
// dormant (no member scored within the same window), so an active
// theme's centroid recompute is never starved of members.

import { sql } from "kysely";
import { db } from "../db/index.ts";
import { coldTierEnabled } from "../shared/cold-tier.ts";
import { getConfigNumber } from "../shared/config-store.ts";
import { withLock } from "../shared/pipeline-lock.ts";
import { offloadPayloads } from "./cold-migrate.ts";

const UNCONFIRMED_TTL_MS = 30 * 24 * 3600 * 1000;
const UNSUBSCRIBED_ANON_TTL_MS = 90 * 24 * 3600 * 1000;
const DISPATCH_LOG_TTL_MS = 180 * 24 * 3600 * 1000;
const DEFAULT_EMBEDDING_HOT_DAYS = 90;
const DEFAULT_UNSCORED_NOISE_DAYS = 30;
const DEFAULT_COLD_TIER_AGE_DAYS = 14;

export async function retention(): Promise<void> {
  await withLock("retention", 5 * 60_000, runRetention);
}

async function runRetention(): Promise<void> {
  const now = Date.now();
  const unconfirmedCutoff = new Date(now - UNCONFIRMED_TTL_MS);
  const unsubscribedCutoff = new Date(now - UNSUBSCRIBED_ANON_TTL_MS);
  const dispatchCutoff = new Date(now - DISPATCH_LOG_TTL_MS);

  // 1. Delete unconfirmed rows past TTL.
  const unconfirmed = await db
    .deleteFrom("email_subscription")
    .where("confirmed_at", "is", null)
    .where("created_at", "<", unconfirmedCutoff)
    .executeTakeFirst();
  const unconfirmedDeleted = Number(unconfirmed.numDeletedRows ?? 0);

  // 2. Anonymize unsubscribed rows past TTL. Set email to a stable
  // null-equivalent so the UNIQUE index still works (Postgres treats
  // NULLs as distinct, so multiple NULLs coexist). Easier than adding
  // a separate suppression-list table.
  const unsubAnon = await db
    .updateTable("email_subscription")
    .set({
      email: sql<string>`'anonymized-' || id::text || '@removed.local'`,
    })
    .where("unsubscribed_at", "is not", null)
    .where("unsubscribed_at", "<", unsubscribedCutoff)
    .where("email", "not like", "anonymized-%@removed.local")
    .executeTakeFirst();
  const unsubAnonymized = Number(unsubAnon.numUpdatedRows ?? 0);

  // 3. Prune old successful dispatch_log rows. Keep bounce/complaint
  // rows indefinitely — they're the "don't try this address again"
  // trail and cost little.
  const dispatchPrune = await db
    .deleteFrom("dispatch_log")
    .where("status", "in", ["noop", "delivered", "sent"])
    .where("dispatched_at", "<", dispatchCutoff)
    .executeTakeFirst();
  const dispatchDeleted = Number(dispatchPrune.numDeletedRows ?? 0);

  // 4. Age out cold individual story embeddings (see header note).
  const embeddingsAged = await ageOutEmbeddings(now);

  // 5. Prune unscored, unreferenced noise rows (see header note).
  const noisePruned = await pruneUnscoredNoise(now);

  // 6. Offload payloads older than the cold-tier window to R2 (rows
  // stay; only the bulky jsonb moves). Inert unless storage.cold_tier
  // is on. See docs/storage.md.
  const offloaded = await offloadColdPayloads();

  console.log(
    `[retention] unconfirmed_deleted=${unconfirmedDeleted} unsub_anonymized=${unsubAnonymized} dispatch_pruned=${dispatchDeleted} embeddings_aged=${embeddingsAged} noise_pruned=${noisePruned} offloaded_ai=${offloaded.ai} offloaded_story=${offloaded.story}`,
  );
}

async function offloadColdPayloads(): Promise<{ ai: number; story: number }> {
  if (!(await coldTierEnabled())) return { ai: 0, story: 0 };
  const days = await getConfigNumber(
    "storage.cold_tier_age_days",
    DEFAULT_COLD_TIER_AGE_DAYS,
  );
  return offloadPayloads({ olderThanDays: days });
}

// Delete unscored, unreferenced story rows past the TTL.
//
// The SQL is the specification, so read the predicate rather than this
// comment: scored_at IS NULL is the invariant-3 guard and every NOT
// EXISTS is a reference that must not be orphaned. story_factor is the
// deliberate omission — it has ON DELETE CASCADE and carries no meaning
// once its story is gone.
//
// Bounded per run. A first run on a long-lived database has a very large
// candidate set, and an unbounded DELETE would hold locks and inflate
// WAL (which on Neon is retained storage, not just churn) for as long as
// it takes. Daily runs drain the backlog over a few days instead.
const NOISE_PRUNE_LIMIT = 5000;

export async function pruneUnscoredNoise(now: number): Promise<number> {
  const days = await getConfigNumber(
    "retention.unscored_noise_days",
    DEFAULT_UNSCORED_NOISE_DAYS,
  );
  // A non-positive TTL means "delete everything unscored", which is
  // never what someone meant to type. Treat it as off.
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = new Date(now - days * 24 * 3600 * 1000);

  // Every filter sits INSIDE the limited subquery, so the LIMIT applies
  // to rows that are actually deletable. Filtering after the LIMIT would
  // starve: if the oldest 5000 unscored rows happen to be referenced, the
  // run deletes nothing and the next run picks the same 5000 forever.
  const result = await sql`
    DELETE FROM story
    WHERE id IN (
      SELECT s.id
      FROM story s
      WHERE s.scored_at IS NULL
        AND s.ingested_at < ${cutoff}
        -- Never a published or drafted pick.
        AND NOT EXISTS (SELECT 1 FROM issue_pick p WHERE p.story_id = s.id)
        -- issue.story_ids is a bare int[] with no FK, so this one is on us.
        AND NOT EXISTS (SELECT 1 FROM issue i WHERE s.id = ANY(i.story_ids))
        -- Human calibration work outlives the score it was made against.
        AND NOT EXISTS (SELECT 1 FROM eval_label e WHERE e.story_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM ground_truth g WHERE g.story_id = s.id)
        -- Another story reused this row's score via dedup. That FK is ON
        -- DELETE SET NULL, so deleting would silently erase the
        -- provenance instead of failing loudly.
        AND NOT EXISTS (
          SELECT 1 FROM story o WHERE o.scored_via_story_id = s.id
        )
      ORDER BY s.ingested_at ASC
      LIMIT ${NOISE_PRUNE_LIMIT}
    )
  `.execute(db);
  return Number(result.numAffectedRows ?? 0);
}

async function ageOutEmbeddings(now: number): Promise<number> {
  const hotDays = await loadEmbeddingHotDays();
  const cutoff = new Date(now - hotDays * 24 * 3600 * 1000);

  // A theme is "dormant" when none of its members were scored within
  // the hot window — so it is not actively gaining members and its
  // centroid will not be recomputed from a fresh arrival. We null
  // embeddings for old stories that are either unthemed or attached to
  // a dormant theme. reembed.ts can regenerate any of them on demand.
  const result = await sql`
    WITH dormant_theme AS (
      SELECT theme_id
      FROM story
      WHERE theme_id IS NOT NULL
      GROUP BY theme_id
      HAVING max(scored_at) < ${cutoff}
    )
    UPDATE story s
    SET embedding = NULL
    WHERE s.embedding IS NOT NULL
      AND s.scored_at IS NOT NULL
      AND s.scored_at < ${cutoff}
      AND (
        s.theme_id IS NULL
        OR s.theme_id IN (SELECT theme_id FROM dormant_theme)
      )
  `.execute(db);
  return Number(result.numAffectedRows ?? 0);
}

async function loadEmbeddingHotDays(): Promise<number> {
  return getConfigNumber(
    "retention.embedding_hot_days",
    DEFAULT_EMBEDDING_HOT_DAYS,
  );
}

