// Daily USD spend guard. Reads `config.budget.daily_usd_cap` and sums
// `ai_call_log.cost_estimate_usd` since UTC midnight. Throws if the cap
// is exceeded. Applied at the top of every Anthropic AI stage's run()
// (scorer, composer, editor, theme-confirm).
//
// Scope: Anthropic only. Voyage embeddings (src/ai/embed.ts) go through
// a different provider and are not tracked in ai_call_log. If Voyage
// spend ever becomes material, extend the logging before gating here.
//
// NOT a perfect barrier: a single in-flight call whose cost pushes over
// the cap still completes. Good enough for the "runaway scorer" failure
// mode, which is the reason this exists.

import { sql } from "kysely";
import { db } from "../db/index.ts";

export class BudgetExceededError extends Error {
  constructor(
    public readonly spentUsd: number,
    public readonly capUsd: number,
  ) {
    super(
      `daily budget cap exceeded: spent $${spentUsd.toFixed(2)} / cap $${capUsd.toFixed(2)}`,
    );
    this.name = "BudgetExceededError";
  }
}

let capCache: { value: number; at: number } | null = null;
const CAP_CACHE_MS = 60_000;

async function loadCap(): Promise<number | null> {
  const now = Date.now();
  if (capCache !== null && now - capCache.at < CAP_CACHE_MS) {
    return capCache.value;
  }
  const row = await db
    .selectFrom("config")
    .select("value")
    .where("key", "=", "budget.daily_usd_cap")
    .executeTakeFirst();
  if (!row) return null;
  const v = typeof row.value === "number" ? row.value : Number(row.value);
  if (!Number.isFinite(v)) return null;
  capCache = { value: v, at: now };
  return v;
}

export async function checkBudget(): Promise<void> {
  const cap = await loadCap();
  if (cap === null) return;
  const { spent } = await db
    .selectFrom("ai_call_log")
    .select(sql<string | null>`coalesce(sum(cost_estimate_usd), 0)`.as("spent"))
    .where("started_at", ">=", startOfUtcDay())
    .executeTakeFirstOrThrow();
  const spentUsd = Number(spent ?? 0);
  if (spentUsd >= cap) throw new BudgetExceededError(spentUsd, cap);
}

function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}
