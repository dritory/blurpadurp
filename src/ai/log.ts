import { db } from "../db/index.ts";
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
    .select("output_jsonb")
    .where("stage_name", "=", params.stage_name)
    .where("stage_version", "=", params.stage_version)
    .where("model_id", "=", params.model_id)
    .where("input_hash", "=", params.input_hash)
    .where("error", "is", null)
    .where("output_jsonb", "is not", null)
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return row?.output_jsonb ?? null;
}

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
      tokens_in: rec.tokens_in,
      tokens_out: rec.tokens_out,
      cost_estimate_usd:
        rec.cost_estimate_usd == null ? null : String(rec.cost_estimate_usd),
      latency_ms: rec.latency_ms,
      error: rec.error,
    })
    .execute();
}
