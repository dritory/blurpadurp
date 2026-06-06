import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { db } from "../../src/db/index.ts";
import {
  bumpFilterHits,
  loadFilterRows,
} from "../../src/shared/filter-store.ts";

const RUN = process.env.RUN_INTEGRATION === "1";

describe.skipIf(!RUN)("filter-store (integration)", () => {
  const clear = () =>
    sql`TRUNCATE title_regex_filter`.execute(db).then(() => {});
  const seed = () =>
    sql`
      INSERT INTO title_regex_filter (pattern, mode, hits) VALUES
        ('^sponsored', 'block', 0),
        ('quiz', 'tag', 2)
    `
      .execute(db)
      .then(() => {});
  beforeEach(clear);
  afterEach(clear);

  test("loadFilterRows returns normalized (pattern, mode) rows", async () => {
    await seed();
    const rows = await loadFilterRows("title_regex_filter");
    expect(new Set(rows.map((r) => `${r.pattern}:${r.mode}`))).toEqual(
      new Set(["^sponsored:block", "quiz:tag"]),
    );
  });

  test("bumpFilterHits increments the hits counter per pattern", async () => {
    await seed();
    await bumpFilterHits(
      "title_regex_filter",
      new Map([
        ["^sponsored", 3],
        ["quiz", 5],
        ["nonexistent", 9], // no row → no-op, no error
      ]),
    );
    const rows = await db
      .selectFrom("title_regex_filter")
      .select(["pattern", "hits"])
      .execute();
    const byPattern = new Map(rows.map((r) => [r.pattern, r.hits]));
    expect(byPattern.get("^sponsored")).toBe(3);
    expect(byPattern.get("quiz")).toBe(7); // started at 2
  });

  test("bumpFilterHits with an empty map is a no-op", async () => {
    await seed();
    await bumpFilterHits("title_regex_filter", new Map());
    const rows = await db
      .selectFrom("title_regex_filter")
      .select(["pattern", "hits"])
      .execute();
    expect(rows.find((r) => r.pattern === "quiz")?.hits).toBe(2);
  });
});
