// Cold-storage offload engine (docs/storage.md).
//
// Relocates inline payloads — ai_call_log (input/output) and story
// (raw_input/raw_output) — older than a cutoff into the object store,
// in bounded batches, then nulls the inline columns. The story/
// ai_call_log ROWS stay; only the bulky payload moves. Rows newer than
// the cutoff keep their payloads inline so the scheduled pipeline
// (compose's ≤7-day editor pool) never has to read from R2.
//
// Idempotent and resumable: each row is moved only if it still has a
// payload and no key. Order is write-object-then-null-row, so a crash
// orphans an object at worst, never dangles a row at a missing key.
// Safe to run live — read paths fall back to inline for un-moved rows.
//
// Driven two ways:
//   - retention stage, daily, with olderThanDays = the configured
//     window (storage.cold_tier_age_days, default 14).
//   - `bun run cli cold-migrate [batchSize] [maxBatches] [olderThanDays]`
//     for the one-time historical backfill (olderThanDays defaults to 0
//     = everything).

import { db } from "../db/index.ts";
import { putPayload } from "../shared/cold-tier.ts";
import {
  aiPayloadKey,
  getObjectStore,
  storyPayloadKey,
} from "../shared/object-store.ts";

export interface OffloadOptions {
  olderThanDays: number;
  batchSize?: number;
  maxBatches?: number;
}

export async function offloadPayloads(
  opts: OffloadOptions,
): Promise<{ ai: number; story: number }> {
  const batchSize = opts.batchSize ?? 500;
  const maxBatches = opts.maxBatches ?? 0;
  const cutoff = new Date(Date.now() - opts.olderThanDays * 24 * 3600_000);
  const ai = await offloadAiCallLog(cutoff, batchSize, maxBatches);
  const story = await offloadStory(cutoff, batchSize, maxBatches);
  return { ai, story };
}

// CLI entry: one-time historical backfill. olderThanDays defaults to 0
// (move everything regardless of age).
export async function coldMigrate(
  batchSize = 500,
  maxBatches = 0,
  olderThanDays = 0,
): Promise<void> {
  console.log(
    `[cold-migrate] backend=${getObjectStore().backend} batch=${batchSize} maxBatches=${maxBatches || "∞"} olderThanDays=${olderThanDays}`,
  );
  const { ai, story } = await offloadPayloads({
    olderThanDays,
    batchSize,
    maxBatches,
  });
  console.log(`[cold-migrate] done — ai_call_log=${ai} story=${story}`);
}

async function offloadAiCallLog(
  cutoff: Date,
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
      .where("started_at", "<", cutoff)
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
      await putPayload(key, { input: row.input_jsonb, output: row.output_jsonb });
      await db
        .updateTable("ai_call_log")
        .set({ payload_key: key, input_jsonb: null, output_jsonb: null })
        .where("id", "=", row.id)
        .execute();
      moved++;
    }
  }
  return moved;
}

async function offloadStory(
  cutoff: Date,
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
      .where("scored_at", "<", cutoff)
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
  }
  return moved;
}
