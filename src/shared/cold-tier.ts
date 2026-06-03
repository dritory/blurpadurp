// Shared cold-storage helpers used by the writers (ai/log.ts,
// pipeline/score.ts) and readers (pipeline/fixture.ts, api). Keeps the
// `storage.cold_tier` switch and the payload envelope codec in one
// place. See docs/storage.md.

import { db } from "../db/index.ts";
import { getObjectStore } from "./object-store.ts";

// Both ai_call_log and story store the same envelope shape: the stage
// input and output (for story: raw_input / raw_output).
export interface PayloadEnvelope {
  input: unknown;
  output: unknown;
}

export async function putPayload(
  key: string,
  env: PayloadEnvelope,
): Promise<void> {
  await getObjectStore().put(key, JSON.stringify(env));
}

// Returns null on a miss or unparesable blob — callers fall back to the
// inline jsonb columns (or, for a cache lookup, treat it as no hit).
export async function getPayload(key: string): Promise<PayloadEnvelope | null> {
  const blob = await getObjectStore().get(key);
  if (blob === null) return null;
  try {
    return JSON.parse(blob) as PayloadEnvelope;
  } catch {
    return null;
  }
}

// In-place hydrate of raw_output for a batch of story rows: rows whose
// payload was offloaded (payload_key set) get their raw_output filled
// from the object store, so existing downstream readers work unchanged.
// One store fetch per offloaded row — callers pass bounded sets (the
// editor pool, shrug candidates, a theme's recent stories).
export async function hydrateRawOutput(
  rows: Array<{ raw_output: unknown; payload_key: string | null }>,
): Promise<void> {
  for (const r of rows) {
    if (r.payload_key !== null) {
      const env = await getPayload(r.payload_key);
      r.raw_output = env?.output ?? null;
    }
  }
}

// Cached read of the `storage.cold_tier` master switch (mig 057).
// Governs offloading for both ai_call_log and story. 60s TTL — config
// is rarely flipped and this sits on the hot AI/score path.
let cache: { value: boolean; at: number } | null = null;
const CACHE_MS = 60_000;

export async function coldTierEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cache !== null && now - cache.at < CACHE_MS) return cache.value;
  const row = await db
    .selectFrom("config")
    .select("value")
    .where("key", "=", "storage.cold_tier")
    .executeTakeFirst();
  const value = row?.value === true;
  cache = { value, at: now };
  return value;
}
