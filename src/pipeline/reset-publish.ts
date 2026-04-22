// Reset the published_to_reader flag on every story. Dev-workflow
// only — use when you need to re-compose against the same pool
// after a prompt tweak. In production, compose flipping this flag
// is the de-duplication mechanism; never reset there.
//
// Does NOT delete issue rows. If you want the archive clean too:
//   DELETE FROM issue;

import { db } from "../db/index.ts";

export async function resetPublish(): Promise<void> {
  const before = await db
    .selectFrom("story")
    .select((eb) => eb.fn.count<number>("id").as("n"))
    .where("published_to_reader", "=", true)
    .executeTakeFirstOrThrow();

  if (Number(before.n) === 0) {
    console.log("[reset-publish] no rows with published_to_reader=true");
    return;
  }

  await db
    .updateTable("story")
    .set({ published_to_reader: false, published_to_reader_at: null })
    .where("published_to_reader", "=", true)
    .execute();

  console.log(
    `[reset-publish] reset ${before.n} stories. issue rows are untouched — drop them manually via SQL if you want the archive clean.`,
  );
}
