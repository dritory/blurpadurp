import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { db } from "../../src/db/index.ts";
import { loadBlocklist } from "../../src/shared/source-blocklist.ts";

const RUN = process.env.RUN_INTEGRATION === "1";

describe.skipIf(!RUN)("source-blocklist loadBlocklist (integration)", () => {
  const clear = () => sql`TRUNCATE source_blocklist`.execute(db).then(() => {});
  beforeEach(clear);
  afterEach(clear);

  test("loads hosts and matches exact + subdomain rollup", async () => {
    await sql`
      INSERT INTO source_blocklist (host) VALUES ('nypost.com'), ('foo.co.uk')
    `.execute(db);
    const bl = await loadBlocklist();
    expect(bl.size).toBe(2);
    expect(bl.has("nypost.com")).toBe(true);
    expect(bl.has("video.nypost.com")).toBe(true); // subdomain rollup
    expect(bl.has("a.foo.co.uk")).toBe(true);
    expect(bl.has("reuters.com")).toBe(false);
  });

  test("an empty table blocks nothing", async () => {
    const bl = await loadBlocklist();
    expect(bl.size).toBe(0);
    expect(bl.has("anything.com")).toBe(false);
  });
});
