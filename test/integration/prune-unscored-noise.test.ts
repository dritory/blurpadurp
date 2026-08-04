// Retention rule 5 (mig 074) — the noise prune. This is a DELETE against
// the largest table in the database, and its whole safety story is a
// predicate, so it gets an integration test rather than a unit test of
// something adjacent to the predicate.
//
// The property under test is not "it deletes rows". It's the two things
// that would be expensive to get wrong: it must never touch a scored row
// (invariant 3), and it must never orphan a reference — including
// issue.story_ids, which is a bare int[] with no foreign key and so has
// no cascade to fall back on.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { db } from "../../src/db/index.ts";
import { pruneUnscoredNoise } from "../../src/pipeline/retention.ts";

const RUN = process.env.RUN_INTEGRATION === "1";

const NOW = Date.UTC(2026, 7, 4);
const OLD = new Date(NOW - 60 * 24 * 3600 * 1000).toISOString(); // 60d
const RECENT = new Date(NOW - 2 * 24 * 3600 * 1000).toISOString(); // 2d

async function insertStory(o: {
  title: string;
  ingestedAt: string;
  scoredAt?: string | null;
  earlyReject?: boolean;
  scoredVia?: number | null;
}): Promise<number> {
  const row = await sql<{ id: number }>`
    INSERT INTO story (source_name, title, as_of_date, ingested_at,
                       scored_at, early_reject, scored_via_story_id)
    VALUES ('test', ${o.title}, '2026-08-04', ${o.ingestedAt},
            ${o.scoredAt ?? null}, ${o.earlyReject ?? false},
            ${o.scoredVia ?? null})
    RETURNING id
  `.execute(db);
  return Number(row.rows[0]!.id);
}

describe.skipIf(!RUN)("pruneUnscoredNoise (integration)", () => {
  const clear = async () => {
    await sql`DELETE FROM issue_pick`.execute(db);
    await sql`DELETE FROM eval_label`.execute(db);
    await sql`DELETE FROM ground_truth`.execute(db);
    await sql`DELETE FROM issue WHERE title LIKE 'prune-test%'`.execute(db);
    await sql`DELETE FROM story WHERE source_name = 'test'`.execute(db);
    await sql`
      INSERT INTO config (key, value) VALUES ('retention.unscored_noise_days', '30'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = '30'::jsonb
    `.execute(db);
  };
  beforeEach(clear);
  afterEach(clear);

  const survives = async (id: number): Promise<boolean> => {
    const r = await sql<{ n: string }>`
      SELECT count(*) AS n FROM story WHERE id = ${id}
    `.execute(db);
    return Number(r.rows[0]!.n) === 1;
  };

  test("deletes an old unscored row", async () => {
    const id = await insertStory({ title: "noise", ingestedAt: OLD });
    expect(await pruneUnscoredNoise(NOW)).toBeGreaterThanOrEqual(1);
    expect(await survives(id)).toBe(false);
  });

  test("keeps an unscored row inside the TTL", async () => {
    const id = await insertStory({ title: "fresh", ingestedAt: RECENT });
    await pruneUnscoredNoise(NOW);
    expect(await survives(id)).toBe(true);
  });

  test("never touches a scored row, however old", async () => {
    // Invariant 3. A scored row's raw_input/raw_output persist forever;
    // the only lever against them is cold-tiering to R2.
    const id = await insertStory({
      title: "scored",
      ingestedAt: OLD,
      scoredAt: OLD,
    });
    await pruneUnscoredNoise(NOW);
    expect(await survives(id)).toBe(true);
  });

  test("deletes a prefilter early-reject", async () => {
    // These keep scored_at NULL (score.ts sets first_pass_* and
    // early_reject only), so they are in scope — and they are a large
    // share of the population once progressive scoring is on.
    const id = await insertStory({
      title: "early-reject",
      ingestedAt: OLD,
      earlyReject: true,
    });
    await pruneUnscoredNoise(NOW);
    expect(await survives(id)).toBe(false);
  });

  test("keeps a row referenced by issue.story_ids", async () => {
    // The one with no foreign key, so no cascade would have caught it.
    const id = await insertStory({ title: "in-issue", ingestedAt: OLD });
    await sql`
      INSERT INTO issue (title, composed_markdown, composed_html, story_ids)
      VALUES ('prune-test issue', '# x', '<p>x</p>', ARRAY[${id}]::bigint[])
    `.execute(db);
    await pruneUnscoredNoise(NOW);
    expect(await survives(id)).toBe(true);
  });

  test("keeps a row another story was scored via", async () => {
    // The FK is ON DELETE SET NULL, so deleting would quietly erase the
    // dedup provenance rather than failing.
    const source = await insertStory({ title: "dedup-source", ingestedAt: OLD });
    await insertStory({
      title: "dedup-child",
      ingestedAt: OLD,
      scoredAt: OLD,
      scoredVia: source,
    });
    await pruneUnscoredNoise(NOW);
    expect(await survives(source)).toBe(true);
  });

  test("keeps a row carrying human calibration work", async () => {
    const labeled = await insertStory({ title: "labeled", ingestedAt: OLD });
    await sql`
      INSERT INTO eval_label (story_id, label) VALUES (${labeled}, 'no')
    `.execute(db);
    await pruneUnscoredNoise(NOW);
    expect(await survives(labeled)).toBe(true);
  });

  test("a zero TTL is treated as off, not as delete-everything", async () => {
    // Regression: this read through getConfigNumber, whose contract is
    // `v > 0 ? v : fallback` — so a configured 0 became 30 and the
    // off-switch quietly performed a 30-day prune instead.
    const id = await insertStory({ title: "noise", ingestedAt: OLD });
    await sql`
      UPDATE config SET value = '0'::jsonb WHERE key = 'retention.unscored_noise_days'
    `.execute(db);
    expect(await pruneUnscoredNoise(NOW)).toBe(0);
    expect(await survives(id)).toBe(true);
  });

  test("a negative TTL is off too", async () => {
    const id = await insertStory({ title: "noise", ingestedAt: OLD });
    await sql`
      UPDATE config SET value = '-1'::jsonb WHERE key = 'retention.unscored_noise_days'
    `.execute(db);
    expect(await pruneUnscoredNoise(NOW)).toBe(0);
    expect(await survives(id)).toBe(true);
  });

  test("a missing key falls back to the 30-day default", async () => {
    // The other half of the OrNull switch: absent must still mean 30, not
    // "off" and not "delete everything".
    const id = await insertStory({ title: "noise", ingestedAt: OLD });
    await sql`
      DELETE FROM config WHERE key = 'retention.unscored_noise_days'
    `.execute(db);
    expect(await pruneUnscoredNoise(NOW)).toBeGreaterThanOrEqual(1);
    expect(await survives(id)).toBe(false);
  });

  test("a referenced oldest row does not starve the prune", async () => {
    // The filters live inside the LIMIT subquery for this reason: if they
    // ran after it, an unreachable oldest row would consume the batch and
    // the prune would make no progress, run after run.
    const pinned = await insertStory({ title: "pinned", ingestedAt: OLD });
    await sql`
      INSERT INTO eval_label (story_id, label) VALUES (${pinned}, 'maybe')
    `.execute(db);
    const deletable = await insertStory({
      title: "deletable",
      ingestedAt: new Date(NOW - 59 * 24 * 3600 * 1000).toISOString(),
    });
    await pruneUnscoredNoise(NOW);
    expect(await survives(pinned)).toBe(true);
    expect(await survives(deletable)).toBe(false);
  });
});
