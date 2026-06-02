// Backfill mover for the cold-storage tier (docs/storage.md).
//
// Relocates existing inline payloads — ai_call_log (input/output) and
// story (raw_input/raw_output) — into the object store in bounded
// batches, then nulls the inline columns. Idempotent and resumable:
// each row is moved only if it still has a payload and no key. Safe to
// run while the pipeline is live — the read paths fall back to inline
// columns for any not-yet-moved row, and newly-written rows already go
// straight to the store once `storage.cold_tier` is on.
//
// Run: bun run cli cold-migrate [batchSize] [maxBatches]
//   batchSize  rows per batch        (default 500)
//   maxBatches cap on batches/table; 0 = until done (default 0)

import { db } from "../db/index.ts";
import { putPayload } from "../shared/cold-tier.ts";
import {
  aiPayloadKey,
  getObjectStore,
  storyPayloadKey,
} from "../shared/object-store.ts";

export async function coldMigrate(
  batchSize = 500,
  maxBatches = 0,
): Promise<void> {
  console.log(
    `[cold-migrate] backend=${getObjectStore().backend} batch=${batchSize} maxBatches=${maxBatches || "∞"}`,
  );
  const ai = await migrateAiCallLog(batchSize, maxBatches);
  const story = await migrateStory(batchSize, maxBatches);
  console.log(`[cold-migrate] done — ai_call_log=${ai} story=${story}`);
}

async function migrateAiCallLog(
  batchSize: number,
  maxBatches: number,
): Promise<number> {
  let moved = 0;
  let batches = 0;
  for (;;) {
    if (maxBatches > 0 && batches >= maxBatches) break;
    const rows = await db
      .selectFrom("ai_call_log")
      .select(["id", "stage_name", "started_at", "input_jsonb", "output_jsonb"])
      .where("payload_key", "is", null)
      .where((eb) =>
        eb.or([
          eb("input_jsonb", "is not", null),
          eb("output_jsonb", "is not", null),
        ]),
      )
      .orderBy("id", "asc")
      .limit(batchSize)
      .execute();
    if (rows.length === 0) break;
    batches++;
    for (const row of rows) {
      const key = aiPayloadKey(
        row.stage_name,
        row.started_at instanceof Date ? row.started_at : new Date(),
      );
      // Write the object before nulling the row, so a crash orphans an
      // object at worst, never dangles a row at a missing key.
      await putPayload(key, { input: row.input_jsonb, output: row.output_jsonb });
      await db
        .updateTable("ai_call_log")
        .set({ payload_key: key, input_jsonb: null, output_jsonb: null })
        .where("id", "=", row.id)
        .execute();
      moved++;
    }
    console.log(`[cold-migrate] ai_call_log batch ${batches}: +${rows.length} (total ${moved})`);
  }
  return moved;
}

async function migrateStory(
  batchSize: number,
  maxBatches: number,
): Promise<number> {
  let moved = 0;
  let batches = 0;
  for (;;) {
    if (maxBatches > 0 && batches >= maxBatches) break;
    const rows = await db
      .selectFrom("story")
      .select(["id", "scored_at", "raw_input", "raw_output"])
      .where("payload_key", "is", null)
      .where((eb) =>
        eb.or([
          eb("raw_input", "is not", null),
          eb("raw_output", "is not", null),
        ]),
      )
      .orderBy("id", "asc")
      .limit(batchSize)
      .execute();
    if (rows.length === 0) break;
    batches++;
    for (const row of rows) {
      const key = storyPayloadKey(
        row.scored_at instanceof Date ? row.scored_at : new Date(),
      );
      await putPayload(key, { input: row.raw_input, output: row.raw_output });
      await db
        .updateTable("story")
        .set({ payload_key: key, raw_input: null, raw_output: null })
        .where("id", "=", row.id)
        .execute();
      moved++;
    }
    console.log(`[cold-migrate] story batch ${batches}: +${rows.length} (total ${moved})`);
  }
  return moved;
}
