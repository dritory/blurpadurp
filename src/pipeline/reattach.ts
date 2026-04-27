// Theme-reattach pass. Consolidates singletons against existing themes
// without re-running the scorer.
//
// Walks every singleton theme (one member story, one), looks up its
// best non-self neighbor by centroid cosine, runs a Haiku theme-confirm
// if the cosine clears the configured attach threshold, and merges
// when the LLM agrees the story is a continuation. The orphan theme
// is deleted, the destination theme's centroid is recomputed, and the
// story's category_id snaps to the destination.
//
// Cost shape: only Haiku theme-confirm calls (~$0.00005 each), no
// Sonnet, no scorer. Cache-on-hash means re-runs are mostly free.
//
// What this CAN'T fix: stories that legitimately don't belong to any
// existing theme — those stay singletons (correctly). And merges that
// the LLM rejects — also correct, but you may see stable singletons
// that look like obvious matches if the embedding cosine is high but
// the LLM disagrees on the event.

import { sql } from "kysely";

import { confirmThemeContinuation } from "../ai/theme-confirm.ts";
import { db } from "../db/index.ts";
import { recomputeThemeCentroid } from "../shared/embedding-utils.ts";

interface SingletonRow {
  theme_id: number;
  story_id: number;
  story_title: string;
  story_summary: string | null;
  story_embedding: string;
}

interface NeighborTheme {
  id: number;
  name: string;
  description: string | null;
  category_id: number;
  cosine: number;
}

export async function reattach(): Promise<void> {
  const cfg = await loadAttachConfig();
  console.log(
    `[reattach] singleton-attach threshold=${cfg.attachThreshold}; merge threshold=${cfg.mergeThreshold}`,
  );

  await runSingletonPhase(cfg);
  await runThemeMergePhase(cfg);
}

async function runSingletonPhase(cfg: AttachConfig): Promise<void> {
  console.log(`[reattach] phase 1: consolidating singletons`);
  const singletons = await loadSingletons();
  console.log(`[reattach] ${singletons.length} singleton themes`);

  let merged = 0;
  let confirmed = 0;
  let rejectedByLlm = 0;
  let belowThreshold = 0;
  let noNeighbor = 0;
  let processed = 0;

  for (const s of singletons) {
    processed++;
    if (processed % 25 === 0) {
      console.log(
        `[reattach] ${processed}/${singletons.length} processed; merged=${merged}`,
      );
    }
    if (s.story_embedding === null) {
      noNeighbor++;
      continue;
    }
    const neighbor = await findBestNeighbor(s);
    if (neighbor === null) {
      noNeighbor++;
      continue;
    }
    if (neighbor.cosine < cfg.attachThreshold) {
      belowThreshold++;
      continue;
    }
    const recentSummaries = await loadRecentSummaries(neighbor.id);
    let isContinuation: boolean;
    try {
      const result = await confirmThemeContinuation({
        story_title: s.story_title,
        story_summary: s.story_summary,
        theme_name: neighbor.name,
        theme_description: neighbor.description,
        recent_summaries: recentSummaries,
        cosine_similarity: neighbor.cosine,
      });
      isContinuation = result.is_continuation;
    } catch (err) {
      console.warn(
        `[reattach] theme-confirm failed for story ${s.story_id} → theme ${neighbor.id}: ${err instanceof Error ? err.message : err}`,
      );
      continue;
    }
    if (!isContinuation) {
      rejectedByLlm++;
      continue;
    }
    confirmed++;
    await mergeSingletonInto(s.theme_id, s.story_id, neighbor);
    await recomputeThemeCentroid(neighbor.id);
    merged++;
  }

  console.log(
    `[reattach] phase 1 done — merged=${merged} confirmed=${confirmed} rejected_by_llm=${rejectedByLlm} below_threshold=${belowThreshold} no_neighbor=${noNeighbor}`,
  );
}

// Phase 2: collapse near-duplicate themes themselves. For each theme
// we fetch its top-k centroid neighbors above merge_threshold and
// process them closest-first. Auto-merges above merge_auto_threshold;
// LLM-gates the band between merge_threshold and merge_auto_threshold.
// Catches cases like "Apple CEO succession" + "Tim Cook stepping down"
// living separately at 0.95 cosine.
//
// Top-k (not top-1) is the load-bearing choice. With top-1 only, if
// A's nearest is C and B's nearest is also C, the pair (A,B) at 0.95
// was never queried — neither side ever named the other as its
// closest neighbor. Top-k surfaces every above-threshold neighbor.
//
// After each merge the absorber's centroid drifts, so we re-query
// top-k inside the per-theme inner loop rather than reusing the
// initial candidate list. rejectedPairs (phase-scoped) prevents
// re-asking the LLM about a theme-pair it already rejected this run.
//
// Multi-pass remains as a safety net: a merge into an already-
// iterated theme T can move T close to themes the outer loop has
// past. Caps at MAX_PASSES; one pass usually suffices once top-k
// is in place.
async function runThemeMergePhase(cfg: AttachConfig): Promise<void> {
  console.log(
    `[reattach] phase 2: merging near-duplicate themes (LLM gate ${cfg.mergeThreshold}–${cfg.mergeAutoThreshold}; auto-merge ≥${cfg.mergeAutoThreshold})`,
  );

  const MAX_PASSES = 5;
  const MAX_NEIGHBORS = 10;
  const rejectedPairs = new Set<string>();
  const pairKey = (a: number, b: number): string =>
    a < b ? `${a}-${b}` : `${b}-${a}`;
  let totalMerged = 0;

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const ids = await db
      .selectFrom("theme")
      .select("id")
      .orderBy("id", "asc")
      .execute();
    console.log(
      `[reattach] phase 2 pass ${pass}: scanning ${ids.length} themes`,
    );

    let mergedAuto = 0;
    let mergedLlm = 0;
    let rejectedByLlm = 0;
    let noCandidates = 0;
    let processed = 0;

    for (const { id } of ids) {
      processed++;
      if (processed % 25 === 0) {
        console.log(
          `[reattach] phase 2 pass ${pass}: ${processed}/${ids.length} processed; merged=${mergedAuto + mergedLlm} (auto=${mergedAuto} llm=${mergedLlm})`,
        );
      }

      // Inner loop: drain every above-threshold neighbor of this
      // theme. Re-queries after each merge so centroid drift and
      // other-pass merges show up. Exits when no eligible candidate
      // remains, or when this theme is absorbed into a lower-id one.
      let iteration = 0;
      let selfAbsorbed = false;
      while (!selfAbsorbed) {
        iteration++;
        const t = await db
          .selectFrom("theme")
          .select(["id", "name", "centroid_embedding"])
          .where("id", "=", id)
          .executeTakeFirst();
        // Theme gone (absorbed earlier this pass) or has no centroid.
        if (!t || t.centroid_embedding === null) break;

        const candidates = await findThemeNeighborsAbove(
          Number(t.id),
          t.centroid_embedding,
          cfg.mergeThreshold,
          MAX_NEIGHBORS,
        );
        if (iteration === 1 && candidates.length === 0) noCandidates++;
        const next = candidates.find(
          (c) => !rejectedPairs.has(pairKey(Number(t.id), c.id)),
        );
        if (!next) break;

        // Convention: lower id absorbs. Merge regardless of which
        // side we iterated from — both sides see each other in the
        // top-k now, so direction-of-discovery no longer matters.
        const absorberId = Math.min(Number(t.id), next.id);
        const absorbedId = Math.max(Number(t.id), next.id);

        // Auto-merge above the high-confidence threshold without LLM
        // gate. The Haiku theme-confirm prompt is calibrated for
        // story→theme; reusing it for theme→theme produced false
        // negatives at 0.95+ cosine where the pairs were obvious
        // duplicates by inspection.
        if (next.cosine >= cfg.mergeAutoThreshold) {
          await mergeThemeInto(absorbedId, absorberId);
          await recomputeThemeCentroid(absorberId);
          mergedAuto++;
          if (absorbedId === Number(t.id)) selfAbsorbed = true;
          continue;
        }

        // Below auto-merge but above merge_threshold: LLM-gate the
        // borderline cases. Haiku-confirm using a representative story
        // from the absorbed theme as the "incoming" and the absorber
        // theme as the candidate — close enough since the rep story
        // is the strongest signal of the absorbed theme's content.
        const repr = await loadRepresentativeStory(absorbedId);
        if (repr === null) {
          rejectedPairs.add(pairKey(Number(t.id), next.id));
          continue;
        }
        const recentSummaries = await loadRecentSummaries(absorberId);
        const absorberTheme = await db
          .selectFrom("theme")
          .select(["name", "description"])
          .where("id", "=", absorberId)
          .executeTakeFirst();
        if (!absorberTheme) {
          rejectedPairs.add(pairKey(Number(t.id), next.id));
          continue;
        }

        let isContinuation: boolean;
        try {
          const result = await confirmThemeContinuation({
            story_title: repr.title,
            story_summary: repr.summary,
            theme_name: absorberTheme.name,
            theme_description: absorberTheme.description,
            recent_summaries: recentSummaries,
            cosine_similarity: next.cosine,
          });
          isContinuation = result.is_continuation;
        } catch (err) {
          console.warn(
            `[reattach] theme-merge confirm failed for ${absorberId}↔${absorbedId}: ${err instanceof Error ? err.message : err}`,
          );
          rejectedPairs.add(pairKey(Number(t.id), next.id));
          continue;
        }
        if (!isContinuation) {
          rejectedByLlm++;
          rejectedPairs.add(pairKey(Number(t.id), next.id));
          continue;
        }

        await mergeThemeInto(absorbedId, absorberId);
        await recomputeThemeCentroid(absorberId);
        mergedLlm++;
        if (absorbedId === Number(t.id)) selfAbsorbed = true;
      }
    }

    const merged = mergedAuto + mergedLlm;
    console.log(
      `[reattach] phase 2 pass ${pass} done — merged=${merged} (auto=${mergedAuto} llm=${mergedLlm}) rejected_by_llm=${rejectedByLlm} no_candidates=${noCandidates}`,
    );
    totalMerged += merged;
    if (merged === 0) {
      console.log(
        `[reattach] phase 2 stable after ${pass} pass${pass === 1 ? "" : "es"} (total merged=${totalMerged})`,
      );
      return;
    }
  }

  console.log(
    `[reattach] phase 2 hit MAX_PASSES=${MAX_PASSES} cap (total merged=${totalMerged}); rerun if needed`,
  );
}

interface AttachConfig {
  attachThreshold: number;
  mergeThreshold: number;
  // At or above this cosine, phase 2 merges without invoking the
  // theme-confirm LLM. Reason: the LLM prompt is calibrated for
  // story→theme ("is this new story a continuation?") and is
  // conservative at theme→theme — it kept rejecting obvious
  // duplicates at 0.95+ cosine. Voyage embeddings at ≥0.95 are
  // empirically almost always the same content. Tunable via config.
  mergeAutoThreshold: number;
}

async function loadAttachConfig(): Promise<AttachConfig> {
  const rows = await db
    .selectFrom("config")
    .select(["key", "value"])
    .where("key", "in", [
      "theme.attach_threshold",
      "theme.merge_threshold",
      "theme.merge_auto_threshold",
    ])
    .execute();
  const parse = (v: unknown, fallback: number): number => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : fallback;
  };
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    attachThreshold: parse(map.get("theme.attach_threshold"), 0.7),
    mergeThreshold: parse(map.get("theme.merge_threshold"), 0.85),
    mergeAutoThreshold: parse(map.get("theme.merge_auto_threshold"), 0.95),
  };
}

// Themes with exactly one member story, where the story has an
// embedding (we can't look up neighbors otherwise).
async function loadSingletons(): Promise<SingletonRow[]> {
  const rows = await db
    .selectFrom("theme")
    .innerJoin("story", "story.theme_id", "theme.id")
    .select([
      "theme.id as theme_id",
      "story.id as story_id",
      "story.title as story_title",
      "story.summary as story_summary",
      "story.embedding as story_embedding",
    ])
    .where("story.embedding", "is not", null)
    .where(({ eb, selectFrom }) =>
      eb(
        "theme.id",
        "in",
        selectFrom("story")
          .select("story.theme_id")
          .where("story.theme_id", "is not", null)
          .groupBy("story.theme_id")
          .having((eb2) => eb2.fn.count("story.id"), "=", 1),
      ),
    )
    .execute();
  return rows.map((r) => ({
    theme_id: Number(r.theme_id),
    story_id: Number(r.story_id),
    story_title: r.story_title,
    story_summary: r.story_summary,
    story_embedding: r.story_embedding!,
  }));
}

// Best non-self theme by cosine similarity to the singleton's story.
async function findBestNeighbor(
  s: SingletonRow,
): Promise<NeighborTheme | null> {
  const embed = s.story_embedding;
  const row = await db
    .selectFrom("theme")
    .select([
      "id",
      "name",
      "description",
      "category_id",
      sql<number>`1 - (centroid_embedding <=> ${embed}::vector)`.as("sim"),
    ])
    .where("centroid_embedding", "is not", null)
    .where("id", "!=", s.theme_id)
    .orderBy(sql`centroid_embedding <=> ${embed}::vector`)
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description,
    category_id: Number(row.category_id),
    cosine: row.sim,
  };
}

async function loadRecentSummaries(themeId: number): Promise<string[]> {
  const rows = await db
    .selectFrom("story")
    .select(["raw_output"])
    .where("theme_id", "=", themeId)
    .where("scored_at", "is not", null)
    .orderBy("scored_at", "desc")
    .limit(3)
    .execute();
  const out: string[] = [];
  for (const r of rows) {
    const raw = r.raw_output as
      | { summary?: string; one_line_summary?: string }
      | null;
    const s = raw?.summary ?? raw?.one_line_summary ?? "";
    if (s.trim().length > 0) out.push(s);
  }
  return out;
}

// All non-self themes whose centroid cosine to `centroid` is at or
// above `threshold`, ordered closest-first, capped at `limit`. Used
// by phase 2's per-theme inner loop. Top-k (not top-1) so that pairs
// at e.g. 0.95 don't get hidden by a third theme that's somebody's
// closer top-1 — the reason near-duplicates were sticking around.
async function findThemeNeighborsAbove(
  themeId: number,
  centroid: string,
  threshold: number,
  limit: number,
): Promise<Array<{ id: number; cosine: number }>> {
  const rows = await db
    .selectFrom("theme")
    .select([
      "id",
      sql<number>`1 - (centroid_embedding <=> ${centroid}::vector)`.as("sim"),
    ])
    .where("centroid_embedding", "is not", null)
    .where("id", "!=", themeId)
    .orderBy(sql`centroid_embedding <=> ${centroid}::vector`)
    .limit(limit)
    .execute();
  return rows
    .map((r) => ({ id: Number(r.id), cosine: Number(r.sim) }))
    .filter((r) => r.cosine >= threshold);
}

// A representative member of a theme — used as the "new story" when
// we reuse confirmThemeContinuation for theme-to-theme judgments.
// Highest-composite story is the strongest proxy for "what this
// theme is about"; falls back to the most recent on no scored
// composite.
async function loadRepresentativeStory(themeId: number): Promise<{
  title: string;
  summary: string | null;
} | null> {
  const row = await db
    .selectFrom("story")
    .select(["title", "summary", "raw_output"])
    .where("theme_id", "=", themeId)
    .orderBy(sql`composite DESC NULLS LAST, ingested_at DESC`)
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  // Prefer the scorer's summary text over raw RSS description for
  // the LLM's view — same reason as the embedding upgrade.
  const raw = row.raw_output as
    | { summary?: string; one_line_summary?: string }
    | null;
  const scorerSummary =
    raw?.summary ?? raw?.one_line_summary ?? null;
  return {
    title: row.title,
    summary: scorerSummary ?? row.summary,
  };
}

// Move every story from `fromThemeId` into `intoThemeId`, then delete
// the now-empty source. Wrapped in a tx so readers never see an
// orphaned story or a half-merged theme.
async function mergeThemeInto(
  fromThemeId: number,
  intoThemeId: number,
): Promise<void> {
  // Carry the destination's category to the moved stories so the
  // story.category_id stays consistent with story.theme_id.
  const dest = await db
    .selectFrom("theme")
    .select(["category_id"])
    .where("id", "=", intoThemeId)
    .executeTakeFirst();
  if (!dest) return;
  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable("story")
      .set({ theme_id: intoThemeId, category_id: dest.category_id })
      .where("theme_id", "=", fromThemeId)
      .execute();
    await tx.deleteFrom("theme").where("id", "=", fromThemeId).execute();
  });
}

// Move the lone member to the destination theme, snap its category to
// match, then delete the origin theme IF it's actually empty after the
// move. Re-checks remaining members inside the tx — the singleton list
// is a snapshot, and another writer (or a previous partial run) may
// have already added or moved stories. Skipping the delete for non-
// empty origins keeps reattach idempotent and FK-safe.
async function mergeSingletonInto(
  fromThemeId: number,
  storyId: number,
  to: NeighborTheme,
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable("story")
      .set({ theme_id: to.id, category_id: to.category_id })
      .where("id", "=", storyId)
      .execute();
    const remaining = await tx
      .selectFrom("story")
      .select(({ fn }) => fn.count<string>("id").as("n"))
      .where("theme_id", "=", fromThemeId)
      .executeTakeFirst();
    if (remaining !== undefined && Number(remaining.n) === 0) {
      await tx.deleteFrom("theme").where("id", "=", fromThemeId).execute();
    }
  });
}
