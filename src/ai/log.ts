import { db } from "../db/index.ts";
import type { AICallRecord } from "./types.ts";

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
