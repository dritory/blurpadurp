// One-shot utility: re-pick the canonical `source_url` for every story
// by preferring tier-1 domains over whatever GDELT's NumMentions-weighted
// pick was. The full URL list (source_url + additional_source_urls) is
// unchanged — only which URL is surfaced as primary changes.

import { db } from "../db/index.ts";
import { isTier1 } from "../shared/source-tiers.ts";

export async function retag(): Promise<void> {
  const stories = await db
    .selectFrom("story")
    .select(["id", "source_url", "additional_source_urls"])
    .execute();

  let swapped = 0;
  let unchanged = 0;
  for (const s of stories) {
    const all: string[] = [];
    if (s.source_url) all.push(s.source_url);
    for (const u of s.additional_source_urls ?? []) all.push(u);
    const unique = Array.from(new Set(all));

    const tier1 = unique.filter(isTier1);
    if (tier1.length === 0) {
      unchanged++;
      continue;
    }
    const newCanonical = tier1[0]!;
    if (newCanonical === s.source_url) {
      unchanged++;
      continue;
    }
    const newAdditional = unique.filter((u) => u !== newCanonical);
    await db
      .updateTable("story")
      .set({
        source_url: newCanonical,
        additional_source_urls: newAdditional,
      })
      .where("id", "=", s.id)
      .execute();
    swapped++;
  }
  console.log(
    `[retag] ${swapped} canonical URLs swapped to tier-1; ${unchanged} unchanged`,
  );
}
