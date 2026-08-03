// DB plumbing for the curated jargon list the gloss-linter consumes
// (gloss_term, mig 062). The linter itself (gloss-lint.ts) is pure and
// takes the loaded terms as an argument; this module is the load + the
// compose-time hit bump, mirroring filter-store.ts.

import { sql } from "kysely";
import { db } from "../db/index.ts";
import type { JargonTerm } from "./gloss-lint.ts";

// The two lists the linter needs, in one round trip: names to WATCH for
// (flag when bare) and names to IGNORE (never flag, at either layer).
// See mig 070 — one table, split on is_ignored.
export interface GlossLists {
  jargon: JargonTerm[];
  ignored: string[];
}

// Snapshot-load both lists. Compose loads them once per run; the review
// page and every checker call load them to lint the current prose.
export async function loadGlossLists(): Promise<GlossLists> {
  const rows = await db
    .selectFrom("gloss_term")
    .select(["term", "note", "is_ignored"])
    .orderBy("term", "asc")
    .execute();
  return {
    jargon: rows
      .filter((r) => !r.is_ignored)
      .map((r) => ({ term: r.term, note: r.note })),
    ignored: rows.filter((r) => r.is_ignored).map((r) => r.term),
  };
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
