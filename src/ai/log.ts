import { db } from "../db/index.ts";
import { getPayload } from "../shared/cold-tier.ts";
import type { AICallRecord } from "./types.ts";

// Look up a prior successful LLM call with this exact input hash.
// Used for idempotent retries — avoids re-paying Haiku/Sonnet after a
// crash between the API call and the downstream persist.
export async function findCachedOutput(params: {
  stage_name: string;
  stage_version: string;
  model_id: string;
  input_hash: string;
}): Promise<unknown | null> {
  const row = await db
    .selectFrom("ai_call_log")
    .select(["output_jsonb", "payload_key"])
    .where("stage_name", "=", params.stage_name)
    .where("stage_version", "=", params.stage_version)
    .where("model_id", "=", params.model_id)
    .where("input_hash", "=", params.input_hash)
    .where("error", "is", null)
    // A usable cache hit has the output either inline (output_jsonb) or
    // offloaded (payload_key). Either qualifies.
    .where((eb) =>
      eb.or([
        eb("output_jsonb", "is not", null),
        eb("payload_key", "is not", null),
      ]),
    )
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();

  if (!row) return null;
  if (row.payload_key !== null) {
    // Cold-stored payload (offloaded by retention once aged past the
    // window). In practice an idempotent retry hits a row written
    // seconds ago, still inline — this path is the rare exact-input
    // recurrence. A miss returns null = "no cache" = re-run the model.
    const env = await getPayload(row.payload_key);
    return env?.output ?? null;
  }
  return row.output_jsonb ?? null;
}

// Always writes the payload inline. The cold tier is retention-driven:
// payloads age out to R2 after storage.cold_tier_age_days, not at write
// time — so the scheduled pipeline never round-trips to R2. See
// docs/storage.md.
export async function logAICall(rec: AICallRecord): Promise<void> {
  await db
    .insertInto("ai_call_log")
    .values({
      stage_name: rec.stage_name,
      stage_version: rec.stage_version,
      model_id: rec.model_id,
      input_hash: rec.input_hash,
      input_jsonb: rec.input_jsonb as never,
      output_jsonb: rec.output_jsonb as never,
      payload_key: null,
      tokens_in: rec.tokens_in,
      tokens_out: rec.tokens_out,
      cost_estimate_usd:
        rec.cost_estimate_usd == null ? null : String(rec.cost_estimate_usd),
      latency_ms: rec.latency_ms,
      error: rec.error,
    })
    .execute();
}
