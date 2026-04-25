// One-shot utility: re-embed every story in the corpus and rebuild
// every theme's centroid from its members. Run after:
//  - switching the embedding model (vectors from different models
//    live in different spaces; cosine across them is meaningless)
//  - changing what we feed the embedder (e.g. moving from raw title
//    to scorer-summary-augmented text — see embedding-utils.ts)

import { embedBatch, toPgVector } from "../ai/embed.ts";
import { db } from "../db/index.ts";
import {
  embeddingTextForStory,
  recomputeThemeCentroid,
} from "../shared/embedding-utils.ts";

const EMBED_BATCH = 128;

export async function reembed(): Promise<void> {
  const stories = await db
    .selectFrom("story")
    .select(["id", "title", "summary", "raw_output"])
    .execute();
  console.log(`[reembed] re-embedding ${stories.length} stories...`);

  let done = 0;
  for (let i = 0; i < stories.length; i += EMBED_BATCH) {
    const batch = stories.slice(i, i + EMBED_BATCH);
    // embeddingTextForStory prefers scorer.summary when available
    // (richer, language-normalized) and falls back to title + raw
    // summary for unscored rows.
    const texts = batch.map(embeddingTextForStory);
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

  const themes = await db
    .selectFrom("theme")
    .select(["id"])
    .execute();
  console.log(`[reembed] rebuilding ${themes.length} theme centroids...`);

  let tDone = 0;
  for (const t of themes) {
    await recomputeThemeCentroid(t.id);
    tDone++;
  }
  console.log(`[reembed] done: ${stories.length} stories, ${tDone} themes`);
}
