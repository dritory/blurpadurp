import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { db } from "../../src/db/index.ts";
import { discardDraft } from "../../src/pipeline/draft.ts";

const RUN = process.env.RUN_INTEGRATION === "1";

// Regression cover for the dispatch_log FK violation.
//
// dispatch_log.issue_id REFERENCES issue(id) with no ON DELETE CASCADE
// (unlike issue_pick / issue_annotation). Once draft-review dispatch
// emails reviewers, a draft owns dispatch_log rows, so discardDraft's
// DELETE FROM issue threw:
//
//   update or delete on table "issue" violates foreign key constraint
//   "dispatch_log_issue_id_fkey" on table "dispatch_log"
//
// This hit production while trying to clear the draft that had stalled
// the pipeline — the discard path is the recovery path, so it failing
// meant the blockage couldn't be cleared at all. Needs a real database:
// the bug IS the constraint, so nothing short of Postgres reproduces it.

describe.skipIf(!RUN)("discardDraft (integration)", () => {
  // Titles are the cleanup handle — ids are serial and we must not
  // touch real issues.
  const DRAFT_TITLE = "itest-discard-draft";
  const PUBLISHED_TITLE = "itest-discard-published";

  const clear = async () => {
    await sql`
      DELETE FROM dispatch_log WHERE issue_id IN (
        SELECT id FROM issue WHERE title IN (${DRAFT_TITLE}, ${PUBLISHED_TITLE})
      )
    `.execute(db);
    await sql`
      DELETE FROM issue WHERE title IN (${DRAFT_TITLE}, ${PUBLISHED_TITLE})
    `.execute(db);
  };
  beforeEach(clear);
  afterEach(clear);

  async function makeIssue(title: string, isDraft: boolean): Promise<number> {
    const row = await db
      .insertInto("issue")
      .values({
        title,
        is_draft: isDraft,
        composed_markdown: "# test",
        composed_html: "<h1>test</h1>",
        story_ids: [],
        // published_seq is NOT NULL for non-drafts (mig 050's CHECK).
        ...(isDraft
          ? {}
          : {
              published_seq: sql<number>`coalesce((SELECT max(published_seq) FROM issue), 0) + 1`,
            }),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return Number(row.id);
  }

  const logSend = (
    issueId: number,
    kind: "email" | "push" | "draft",
    subId: number,
    status: string,
  ) =>
    db
      .insertInto("dispatch_log")
      .values({
        issue_id: issueId,
        subscription_kind: kind,
        subscription_id: subId,
        status,
      })
      .execute();

  const countLogs = async (issueId: number): Promise<number> => {
    const r = await db
      .selectFrom("dispatch_log")
      .select(({ fn }) => fn.countAll<number>().as("n"))
      .where("issue_id", "=", issueId)
      .executeTakeFirstOrThrow();
    return Number(r.n);
  };

  const exists = async (issueId: number): Promise<boolean> =>
    (await db
      .selectFrom("issue")
      .select("id")
      .where("id", "=", issueId)
      .executeTakeFirst()) !== undefined;

  test("discards a draft that was never dispatched", async () => {
    const id = await makeIssue(DRAFT_TITLE, true);
    expect(await discardDraft(id)).toBe(true);
    expect(await exists(id)).toBe(false);
  });

  // The actual regression: a draft emailed to reviewers.
  test("discards a draft that HAS been emailed to reviewers", async () => {
    const id = await makeIssue(DRAFT_TITLE, true);
    await logSend(id, "draft", 1, "sent");
    await logSend(id, "draft", 2, "bounce_hard");
    expect(await countLogs(id)).toBe(2);

    expect(await discardDraft(id)).toBe(true);
    expect(await exists(id)).toBe(false);
    // Rows must be gone, not orphaned — the FK would have blocked us.
    expect(await countLogs(id)).toBe(0);
  });

  // The EXISTS guard: a published issue's send log is a real audit
  // trail and must survive a discard call aimed at its id.
  test("refuses a published issue and leaves its dispatch_log intact", async () => {
    const id = await makeIssue(PUBLISHED_TITLE, false);
    await logSend(id, "email", 1, "delivered");

    expect(await discardDraft(id)).toBe(false);
    expect(await exists(id)).toBe(true);
    expect(await countLogs(id)).toBe(1);
  });
});
