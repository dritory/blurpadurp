// Backfill mover for the cold-storage tier (docs/storage.md).
//
// Relocates existing ai_call_log payloads (input_jsonb/output_jsonb)
// into the object store, in bounded batches, then nulls the inline
// columns. Idempotent and resumable: each row is moved only if it still
// has a payload and no key. Safe to run while the pipeline is live —
// the read path falls back to inline jsonb for any not-yet-moved row,
// and newly-written rows already go straight to the store once
// `storage.cold_tier` is on.
//
// Run: bun run cli cold-migrate [batchSize] [maxBatches]
//   batchSize  rows per batch        (default 500)
//   maxBatches cap on batches; 0 = until done (default 0)

import { getObjectStore, aiPayloadKey } from "../shared/object-store.ts";
import { db } from "../db/index.ts";

export async function coldMigrate(
  batchSize = 500,
  maxBatches = 0,
): Promise<void> {
  const store = getObjectStore();
  console.log(
    `[cold-migrate] backend=${store.backend} batch=${batchSize} maxBatches=${maxBatches || "∞"}`,
  );

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
      await store.put(
        key,
        JSON.stringify({ input: row.input_jsonb, output: row.output_jsonb }),
      );
      // Set the key and null the inline payload in one statement. The
      // order (write-object-then-update-row) means a crash leaves an
      // orphan object at worst, never a row pointing at a missing key.
      await db
        .updateTable("ai_call_log")
        .set({ payload_key: key, input_jsonb: null, output_jsonb: null })
        .where("id", "=", row.id)
        .execute();
      moved++;
    }
    console.log(`[cold-migrate] batch ${batches}: moved ${rows.length} (total ${moved})`);
  }

  console.log(`[cold-migrate] done — moved ${moved} payloads in ${batches} batches`);
}
