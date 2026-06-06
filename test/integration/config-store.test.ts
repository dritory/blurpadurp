import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { db } from "../../src/db/index.ts";
import {
  getConfigNumber,
  getConfigNumberOrNull,
} from "../../src/shared/config-store.ts";

const RUN = process.env.RUN_INTEGRATION === "1";

// Namespaced keys + targeted cleanup so we never disturb seeded config rows.
const KEYS = ["test.itest.num", "test.itest.zero", "test.itest.str"];

describe.skipIf(!RUN)("config-store (integration)", () => {
  const setConfig = (key: string, jsonLiteral: string) =>
    sql`
      INSERT INTO config (key, value) VALUES (${key}, ${sql.raw(jsonLiteral)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `
      .execute(db)
      .then(() => {});
  const clear = () =>
    sql`DELETE FROM config WHERE key = ANY(${KEYS})`.execute(db).then(() => {});
  beforeEach(clear);
  afterEach(clear);

  test("getConfigNumber reads a positive number", async () => {
    await setConfig("test.itest.num", "7");
    expect(await getConfigNumber("test.itest.num", 99)).toBe(7);
  });

  test("getConfigNumber falls back on missing / non-positive / non-numeric", async () => {
    expect(await getConfigNumber("test.itest.num", 99)).toBe(99); // missing
    await setConfig("test.itest.zero", "0");
    expect(await getConfigNumber("test.itest.zero", 99)).toBe(99); // not > 0
    await setConfig("test.itest.str", '"nope"');
    expect(await getConfigNumber("test.itest.str", 99)).toBe(99); // non-numeric
  });

  test("getConfigNumberOrNull permits zero but nulls on missing/non-numeric", async () => {
    await setConfig("test.itest.zero", "0");
    expect(await getConfigNumberOrNull("test.itest.zero")).toBe(0);
    expect(await getConfigNumberOrNull("test.itest.num")).toBeNull(); // missing
    await setConfig("test.itest.str", '"nope"');
    expect(await getConfigNumberOrNull("test.itest.str")).toBeNull();
  });
});
