// Cross-process mutex for pipeline stages. A row in `pipeline_lock`
// keyed on stage_name is the lock; INSERT is acquisition, DELETE is
// release, unique-violation is "somebody else has it."
//
// Semantics on conflict:
//   - Second caller does NOT wait, does NOT retry. It logs one line
//     and returns normally. Fly's next scheduled firing handles it.
//   - The row is TTL'd: if a process dies without running its finally
//     block (SIGKILL, OOM, hardware), the next acquisition clears
//     any row past its expiry before attempting its own INSERT.
//
// Deliberately not pg_advisory_lock — see migrations/024 comment.

import { db } from "../db/index.ts";

export async function withLock<T>(
  stage: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  // Clear any stale row for this stage before trying to claim.
  await db
    .deleteFrom("pipeline_lock")
    .where("stage_name", "=", stage)
    .where("expires_at", "<", new Date())
    .execute();

  const expiresAt = new Date(Date.now() + ttlMs);
  try {
    await db
      .insertInto("pipeline_lock")
      .values({ stage_name: stage, expires_at: expiresAt })
      .execute();
  } catch (err) {
    // Unique-violation: another process holds the lock. Any other
    // error we rethrow — it's probably a connection issue the stage
    // would have hit anyway.
    if (isUniqueViolation(err)) {
      console.log(`[${stage}] another run in progress, exiting`);
      return undefined;
    }
    throw err;
  }

  try {
    return await fn();
  } finally {
    await db
      .deleteFrom("pipeline_lock")
      .where("stage_name", "=", stage)
      .execute()
      .catch((e) => {
        // Don't mask the original error if fn() threw. Just warn.
        console.warn(`[${stage}] failed to release lock: ${e}`);
      });
  }
}

function isUniqueViolation(err: unknown): boolean {
  // pg error code 23505 = unique_violation. The pg driver surfaces it
  // on the error object as `code`.
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "23505";
}

// Exported for tests + ops — useful at psql for `SELECT * FROM
// pipeline_lock` equivalent without leaving the repo.
export async function listActiveLocks(): Promise<
  Array<{ stage_name: string; acquired_at: Date; expires_at: Date }>
> {
  const rows = await db
    .selectFrom("pipeline_lock")
    .select(["stage_name", "acquired_at", "expires_at"])
    .execute();
  return rows as Array<{
    stage_name: string;
    acquired_at: Date;
    expires_at: Date;
  }>;
}

