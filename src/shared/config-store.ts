// Single-key reads of the `config` table.
//
// The full-config load for the scorer/composer stages stays bespoke
// (loadConfig in score.ts / compose.ts) because each validates a
// different required-key set. But the one-off "read this numeric knob,
// fall back to a default" pattern was copy-pasted across budget.ts,
// status.ts, retention.ts, static-export.tsx and api/index.tsx — these
// helpers collapse it.

import { db } from "../db/index.ts";

async function readConfigValue(key: string): Promise<unknown> {
  const row = await db
    .selectFrom("config")
    .select("value")
    .where("key", "=", key)
    .executeTakeFirst();
  return row?.value;
}

// Read a positive numeric config value, falling back when the key is
// missing, non-numeric, or not strictly positive. Used for thresholds
// and retention windows where zero/negative is never meaningful.
export async function getConfigNumber(
  key: string,
  fallback: number,
): Promise<number> {
  const raw = await readConfigValue(key);
  const v = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// Read a numeric config value, returning null when missing/non-numeric.
// Unlike getConfigNumber this permits zero (a daily spend cap of 0 means
// "halt all spend", which is a legitimate setting).
export async function getConfigNumberOrNull(
  key: string,
): Promise<number | null> {
  const raw = await readConfigValue(key);
  if (raw === undefined || raw === null) return null;
  const v = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(v) ? v : null;
}
