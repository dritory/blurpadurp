// Pipeline stage: compose.
// Pulls stories that passed the gate and haven't been published yet,
// calls the composer, persists an `issue` and marks the stories as
// published. For v0 there's a single cadence — one issue per run,
// containing every currently-passing, unpublished story.

import { makeComposer } from "../ai/composer.ts";
import { db } from "../db/index.ts";
import { countTier1 } from "../shared/source-tiers.ts";
import type {
  ComposerInput,
  ComposerOutput,
} from "../shared/composer-schema.ts";

// Read scorer fields from raw_output jsonb. Old rows (v0.1) stored
// `one_line_summary` and `reasoning.retrodiction_12mo`; newer rows store
// `summary` with the reasoning block unchanged for retrodiction.
function readScorerOutput(rawOutput: unknown): {
  summary: string;
  retrodiction: string;
} {
  const r = rawOutput as {
    summary?: string;
    one_line_summary?: string;
    reasoning?: { retrodiction_12mo?: string };
  } | null;
  return {
    summary: r?.summary ?? r?.one_line_summary ?? "",
    retrodiction: r?.reasoning?.retrodiction_12mo ?? "",
  };
}

const COMPOSER_PROMPT_PATH = "docs/composer-prompt.md";

type ConfigMap = {
  "composer.model_id": string;
  "composer.prompt_version": string;
  "composer.max_tokens": number;
  "composer.max_stories": number;
};

export async function compose(): Promise<void> {
  const cfg = await loadConfig();
  const composer = makeComposer({
    version: cfg["composer.prompt_version"],
    modelId: cfg["composer.model_id"],
    promptPath: COMPOSER_PROMPT_PATH,
    maxTokens: cfg["composer.max_tokens"],
  });

  const rows = await db
    .selectFrom("story")
    .leftJoin("theme", "theme.id", "story.theme_id")
    .leftJoin("category", "category.id", "story.category_id")
    .select([
      "story.id as story_id",
      "story.title",
      "story.summary",
      "story.source_url",
      "story.additional_source_urls",
      "category.slug as category_slug",
      "theme.name as theme_name",
      "story.theme_id",
      "story.theme_relationship",
      "story.zeitgeist_score",
      "story.half_life",
      "story.reach",
      "story.composite",
      "story.raw_output",
    ])
    .where("story.passed_gate", "=", true)
    .where("story.published_to_reader", "=", false)
    .orderBy("story.composite", "desc")
    .execute();

  if (rows.length === 0) {
    console.log("[compose] no passing, unpublished stories — skipping");
    return;
  }

  // Cap the issue at composer.max_stories. Re-rank passers primarily by
  // tier-1 source coverage (reputable outlets beat regional aggregators)
  // and secondarily by composite — keeps the precision story but prefers
  // events that professional newsrooms actually reported.
  const ranked = rows
    .map((r) => ({
      row: r,
      tier1: countTier1([
        ...(r.source_url ? [r.source_url] : []),
        ...(r.additional_source_urls ?? []),
      ]),
    }))
    .sort((a, b) => {
      if (b.tier1 !== a.tier1) return b.tier1 - a.tier1;
      const ca = a.row.composite !== null ? Number(a.row.composite) : 0;
      const cb = b.row.composite !== null ? Number(b.row.composite) : 0;
      return cb - ca;
    });
  const capped = ranked
    .slice(0, cfg["composer.max_stories"])
    .map((x) => x.row);
  if (capped.length < rows.length) {
    console.log(
      `[compose] ${rows.length} passers → capping issue at ${capped.length} (composer.max_stories)`,
    );
  }

  const stories: ComposerInput["stories"] = capped.map((r) => {
    const out = readScorerOutput(r.raw_output);
    return {
      story_id: Number(r.story_id),
      title: r.title,
      summary: r.summary,
      source_url: r.source_url,
      additional_source_urls: r.additional_source_urls ?? [],
      category: (r.category_slug as ComposerInput["stories"][number]["category"]) ?? null,
      theme_name: r.theme_name,
      theme_relationship:
        (r.theme_relationship as ComposerInput["stories"][number]["theme_relationship"]) ?? null,
      zeitgeist_score: r.zeitgeist_score ?? 0,
      half_life: r.half_life ?? 0,
      reach: r.reach ?? 0,
      composite: r.composite !== null ? Number(r.composite) : 0,
      scorer_one_liner: out.summary,
      retrodiction_12mo: out.retrodiction,
    };
  });

  const prior_theme_context = await loadPriorThemeContext(
    capped.map((r) => r.theme_id).filter((id): id is number => id !== null),
  );

  const input: ComposerInput = {
    week_of: new Date().toISOString().slice(0, 10),
    stories,
    prior_theme_context,
  };

  console.log(
    `[compose] composing ${stories.length} stories; prior_theme_context=${prior_theme_context.length}`,
  );
  const output = await composer.run(input);
  const storyIds = stories.map((s) => s.story_id);

  const issueId = await persistIssue(output, storyIds, cfg);
  console.log(
    `[compose] issue ${issueId} published: ${storyIds.length} stories, ${output.markdown.length} md chars`,
  );
}

async function loadPriorThemeContext(
  themeIds: number[],
): Promise<ComposerInput["prior_theme_context"]> {
  const unique = [...new Set(themeIds)];
  if (unique.length === 0) return [];

  const out: ComposerInput["prior_theme_context"] = [];
  for (const tid of unique) {
    const prior = await db
      .selectFrom("story")
      .leftJoin("theme", "theme.id", "story.theme_id")
      .select([
        "theme.name as theme_name",
        "story.published_to_reader_at",
        "story.raw_output",
      ])
      .where("story.theme_id", "=", tid)
      .where("story.published_to_reader", "=", true)
      .orderBy("story.published_to_reader_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!prior || !prior.theme_name) continue;
    const scored = readScorerOutput(prior.raw_output);
    out.push({
      theme_name: prior.theme_name,
      last_published:
        prior.published_to_reader_at?.toISOString().slice(0, 10) ?? "",
      last_one_liner: scored.summary,
    });
  }
  return out;
}

async function persistIssue(
  output: ComposerOutput,
  storyIds: number[],
  cfg: ConfigMap,
): Promise<number> {
  return db.transaction().execute(async (tx) => {
    const issue = await tx
      .insertInto("issue")
      .values({
        is_event_driven: false,
        composed_markdown: output.markdown,
        composed_html: output.html,
        story_ids: storyIds,
        composer_prompt_version: cfg["composer.prompt_version"],
        composer_model_id: cfg["composer.model_id"],
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await tx
      .updateTable("story")
      .set({
        published_to_reader: true,
        published_to_reader_at: new Date(),
      })
      .where("id", "in", storyIds)
      .execute();

    return Number(issue.id);
  });
}

async function loadConfig(): Promise<ConfigMap> {
  const rows = await db
    .selectFrom("config")
    .select(["key", "value"])
    .execute();
  const map: Record<string, unknown> = {};
  for (const r of rows) map[r.key] = r.value;

  const required = [
    "composer.model_id",
    "composer.prompt_version",
    "composer.max_tokens",
    "composer.max_stories",
  ] as const;
  for (const k of required) {
    if (map[k] === undefined) throw new Error(`missing config key: ${k}`);
  }
  return map as ConfigMap;
}
