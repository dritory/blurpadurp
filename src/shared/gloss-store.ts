// DB plumbing for the curated jargon list the gloss-linter consumes
// (gloss_term, mig 062). The linter itself (gloss-lint.ts) is pure and
// takes the loaded terms as an argument; this module is the load + the
// compose-time hit bump, mirroring filter-store.ts.

import { sql } from "kysely";
import { db } from "../db/index.ts";
import type { JargonTerm } from "./gloss-lint.ts";

// Snapshot-load every jargon term. Compose loads the full list once per
// run; the review page loads it to re-lint for the advisory panel.
export async function loadGlossTerms(): Promise<JargonTerm[]> {
  const rows = await db
    .selectFrom("gloss_term")
    .select(["term", "note"])
    .orderBy("term", "asc")
    .execute();
  return rows.map((r) => ({ term: r.term, note: r.note }));
}

// Bump the hit counter for terms that appeared un-glossed in a composed
// draft. Called once at compose time with the set of flagged jargon
// terms, so the operator gets observability (which terms recur) without
// a write on the read-only review path.
export async function bumpGlossHits(terms: Iterable<string>): Promise<void> {
  const list = [...new Set(terms)];
  if (list.length === 0) return;
  await db
    .updateTable("gloss_term")
    .set({ hits: sql`hits + 1` })
    .where("term", "in", list)
    .execute();
}
