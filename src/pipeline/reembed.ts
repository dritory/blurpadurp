// One-shot utility: re-embed every story in the corpus and rebuild
// every theme's centroid from its members. Run after switching the
// embedding model — embeddings from different models live in different
// vector spaces and cosine similarities across spaces are meaningless.

import { sql } from "kysely";

import { embedBatch, toPgVector } from "../ai/embed.ts";
import { db } from "../db/index.ts";

const EMBED_BATCH = 128;

export async function reembed(): Promise<void> {
  const stories = await db
    .selectFrom("story")
    .select(["id", "title", "summary"])
    .execute();
  console.log(`[reembed] re-embedding ${stories.length} stories...`);

  let done = 0;
  for (let i = 0; i < stories.length; i += EMBED_BATCH) {
    const batch = stories.slice(i, i + EMBED_BATCH);
    const texts = batch.map(
      (s) => `${s.title}\n\n${s.summary ?? ""}`.trim(),
    );
    const vecs = await embedBatch(texts, "document");
    for (let j = 0; j < batch.length; j++) {
      const story = batch[j];
      const vec = vecs[j];
      if (!story || !vec) continue;
      await db
        .updateTable("story")
        .set({ embedding: toPgVector(vec) })
        .where("id", "=", story.id)
        .execute();
    }
    done += batch.length;
    console.log(`[reembed] stories ${done}/${stories.length}`);
  }

  // Rebuild theme centroids as average of member stories' new embeddings.
  // pgvector's `vector` type doesn't support aggregate AVG directly, but
  // we can compute the element-wise mean via a CTE that unnests arrays.
  // Simpler: pull member embeddings per theme into TypeScript, average,
  // write back.
  const themes = await db
    .selectFrom("theme")
    .select(["id"])
    .execute();
  console.log(`[reembed] rebuilding ${themes.length} theme centroids...`);

  let tDone = 0;
  for (const t of themes) {
    const members = await db
      .selectFrom("story")
      .select(["embedding"])
      .where("theme_id", "=", t.id)
      .where("embedding", "is not", null)
      .execute();
    if (members.length === 0) {
      await db
        .updateTable("theme")
        .set({ centroid_embedding: null })
        .where("id", "=", t.id)
        .execute();
      continue;
    }
    const vectors = members
      .map((m) => parsePgVector(m.embedding))
      .filter((v): v is number[] => v !== null);
    if (vectors.length === 0) continue;
    const mean = averageVectors(vectors);
    await db
      .updateTable("theme")
      .set({ centroid_embedding: toPgVector(mean) })
      .where("id", "=", t.id)
      .execute();
    tDone++;
  }
  console.log(`[reembed] done: ${stories.length} stories, ${tDone} themes`);
}

function parsePgVector(s: string | null): number[] | null {
  if (!s) return null;
  const trimmed = s.replace(/^\[|\]$/g, "");
  if (!trimmed) return null;
  return trimmed.split(",").map(Number);
}

function averageVectors(vectors: number[][]): number[] {
  const dim = vectors[0]!.length;
  const out = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i]! += v[i]!;
  for (let i = 0; i < dim; i++) out[i]! /= vectors.length;
  return out;
}
