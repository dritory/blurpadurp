import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { db } from "../../src/db/index.ts";
import {
  isLockHeld,
  listActiveLocks,
  withLock,
} from "../../src/shared/pipeline-lock.ts";

// Only run when explicitly enabled (CI integration job / `bun run
// test:integration`), so a bare `bun test` with no database skips cleanly.
const RUN = process.env.RUN_INTEGRATION === "1";

describe.skipIf(!RUN)("pipeline-lock (integration)", () => {
  const clear = () => sql`TRUNCATE pipeline_lock`.execute(db).then(() => {});
  beforeEach(clear);
  afterEach(clear);

  test("withLock runs fn while holding the lock, then releases", async () => {
    let heldDuring = false;
    const result = await withLock("score", 60_000, async () => {
      heldDuring = await isLockHeld("score");
      return 42;
    });
    expect(result).toBe(42);
    expect(heldDuring).toBe(true);
    expect(await isLockHeld("score")).toBe(false);
    expect(await listActiveLocks()).toHaveLength(0);
  });

  test("a second holder of the same stage returns undefined and skips fn", async () => {
    await withLock("ingest", 60_000, async () => {
      let innerRan = false;
      const second = await withLock("ingest", 60_000, async () => {
        innerRan = true;
        return 1;
      });
      expect(second).toBeUndefined();
      expect(innerRan).toBe(false);
    });
  });

  test("different stages are independent", async () => {
    await withLock("ingest", 60_000, async () => {
      const other = await withLock("score", 60_000, async () => "ok");
      expect(other).toBe("ok");
    });
  });

  test("an expired lock is cleared and re-acquirable; isLockHeld ignores it", async () => {
    await db
      .insertInto("pipeline_lock")
      .values({ stage_name: "compose", expires_at: new Date(Date.now() - 1000) })
      .execute();
    expect(await isLockHeld("compose")).toBe(false);
    const result = await withLock("compose", 60_000, async () => "acquired");
    expect(result).toBe("acquired");
  });

  test("the lock is released even when fn throws", async () => {
    await expect(
      withLock("dispatch", 60_000, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await isLockHeld("dispatch")).toBe(false);
  });
});
