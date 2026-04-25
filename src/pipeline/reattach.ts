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
    `[reattach] threshold=${cfg.attachThreshold}; processing singletons…`,
  );

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
    `[reattach] done — merged=${merged} confirmed=${confirmed} rejected_by_llm=${rejectedByLlm} below_threshold=${belowThreshold} no_neighbor=${noNeighbor}`,
  );
}

async function loadAttachConfig(): Promise<{ attachThreshold: number }> {
  const row = await db
    .selectFrom("config")
    .select(["key", "value"])
    .where("key", "=", "theme.attach_threshold")
    .executeTakeFirst();
  const v = row?.value;
  const parsed =
    typeof v === "number"
      ? v
      : typeof v === "string"
        ? Number(v)
        : null;
  return {
    attachThreshold: parsed !== null && Number.isFinite(parsed) ? parsed : 0.7,
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
