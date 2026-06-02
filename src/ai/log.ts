import { db } from "../db/index.ts";
import { coldTierEnabled, getPayload, putPayload } from "../shared/cold-tier.ts";
import { aiPayloadKey } from "../shared/object-store.ts";
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
    // Cold-stored payload. A miss here (object absent / transport
    // error returns null) just means "no cache" — the caller re-runs
    // the model, which is the safe degradation.
    const env = await getPayload(row.payload_key);
    return env?.output ?? null;
  }
  return row.output_jsonb ?? null;
}

export async function logAICall(rec: AICallRecord): Promise<void> {
  const base = {
    stage_name: rec.stage_name,
    stage_version: rec.stage_version,
    model_id: rec.model_id,
    input_hash: rec.input_hash,
    tokens_in: rec.tokens_in,
    tokens_out: rec.tokens_out,
    cost_estimate_usd:
      rec.cost_estimate_usd == null ? null : String(rec.cost_estimate_usd),
    latency_ms: rec.latency_ms,
    error: rec.error,
  };

  if (await coldTierEnabled()) {
    const key = aiPayloadKey(rec.stage_name);
    try {
      await putPayload(key, {
        input: rec.input_jsonb,
        output: rec.output_jsonb,
      });
      await db
        .insertInto("ai_call_log")
        .values({
          ...base,
          input_jsonb: null,
          output_jsonb: null,
          payload_key: key,
        })
        .execute();
      return;
    } catch (e) {
      // Never lose the record over a storage hiccup — fall back to
      // writing the payload inline this once.
      console.warn(
        `[ai-log] cold-store write failed, storing inline: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  await db
    .insertInto("ai_call_log")
    .values({
      ...base,
      input_jsonb: rec.input_jsonb as never,
      output_jsonb: rec.output_jsonb as never,
      payload_key: null,
    })
    .execute();
}
