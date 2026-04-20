// Pipeline stage: compose.
// Pulls stories that passed the gate and haven't been published yet,
// calls the composer, persists an `issue` and marks the stories as
// published. For v0 there's a single cadence — one issue per run,
// containing every currently-passing, unpublished story.

import { makeComposer } from "../ai/composer.ts";
import { makeEditor } from "../ai/editor.ts";
import { db } from "../db/index.ts";
import { countTier1 } from "../shared/source-tiers.ts";
import type {
  ComposerInput,
  ComposerOutput,
} from "../shared/composer-schema.ts";
import type { EditorInput } from "../shared/editor-schema.ts";
import type { ScorerOutput } from "../shared/scoring-schema.ts";

// Penalty factors that push an otherwise-picked story into the Worth
// watching section rather than the main-body tiers. Mirrors the
// scoring rubric vocabulary — keep in sync with scoring-schema.ts.
const WATCH_PENALTY_FACTORS = new Set([
  "unreplicated",
  "preclinical_only",
  "insufficient_evidence",
]);

// Penalty factors that qualify a scored, failed-gate story for the Worth
// a shrug section. These are the "hype" markers from the scorer rubric:
// items the algorithm pushed that this brief refuses.
const SHRUG_PENALTY_FACTORS = [
  "in_circle_hype",
  "manufactured_hype",
  "controversy_flash",
] as const;

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
const EDITOR_PROMPT_PATH = "docs/editor-prompt.md";

// Only consider stories ingested within this window. Defense-in-depth
// against stale content leaking through (evergreen RSS items, re-ingested
// archive URLs). Independent of published_at, which can be NULL.
const COMPOSE_INGEST_WINDOW_MS = 14 * 24 * 3600_000;

type ConfigMap = {
  "composer.model_id": string;
  "composer.prompt_version": string;
  "composer.max_tokens": number;
  "editor.model_id": string;
  "editor.prompt_version": string;
  "editor.max_tokens": number;
  "editor.pool_size": number;
};

export async function compose(): Promise<void> {
  const cfg = await loadConfig();
  const composer = makeComposer({
    version: cfg["composer.prompt_version"],
    modelId: cfg["composer.model_id"],
    promptPath: COMPOSER_PROMPT_PATH,
    maxTokens: cfg["composer.max_tokens"],
  });
  const editor = makeEditor({
    version: cfg["editor.prompt_version"],
    modelId: cfg["editor.model_id"],
    promptPath: EDITOR_PROMPT_PATH,
    maxTokens: cfg["editor.max_tokens"],
  });

  const cutoff = new Date(Date.now() - COMPOSE_INGEST_WINDOW_MS);
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
      "story.non_obviousness",
      "story.composite",
      "story.point_in_time_confidence",
      "story.raw_output",
    ])
    .where("story.passed_gate", "=", true)
    .where("story.published_to_reader", "=", false)
    .where("story.ingested_at", ">=", cutoff)
    .orderBy("story.composite", "desc")
    .execute();

  if (rows.length === 0) {
    console.log("[compose] no passing, unpublished stories — skipping");
    return;
  }

  // Editor picks the shortlist from the top-N passers. Pool is ranked by
  // tier-1 coverage then composite — gives the editor the highest-quality
  // slice to curate rather than raw NumMentions leaders.
  const ranked = rows
    .map((r) => {
      const allUrls = [
        ...(r.source_url ? [r.source_url] : []),
        ...(r.additional_source_urls ?? []),
      ];
      return {
        row: r,
        tier1: countTier1(allUrls),
        total: allUrls.length,
      };
    })
    .sort((a, b) => {
      if (b.tier1 !== a.tier1) return b.tier1 - a.tier1;
      const ca = a.row.composite !== null ? Number(a.row.composite) : 0;
      const cb = b.row.composite !== null ? Number(b.row.composite) : 0;
      return cb - ca;
    });

  const poolSize = Math.min(cfg["editor.pool_size"], ranked.length);
  const pool = ranked.slice(0, poolSize);
  console.log(
    `[compose] ${rows.length} passers → editor pool of ${poolSize}`,
  );

  const editorResult = await curateViaEditor(editor, pool);
  const picks = editorResult.picks;
  const pickIds = new Set(picks.map((p) => p.story_id));
  const byId = new Map(pool.map((p) => [Number(p.row.story_id), p.row]));

  // Order stories by editor-assigned rank (1 = headline). Skip picks that
  // name an unknown story_id — the tool schema doesn't prevent that.
  const capped = picks
    .sort((a, b) => a.rank - b.rank)
    .map((p) => byId.get(p.story_id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);

  if (capped.length === 0) {
    console.log("[compose] editor returned no valid picks — aborting");
    return;
  }
  if (capped.length !== pickIds.size) {
    console.warn(
      `[compose] editor picked ${pickIds.size} ids but only ${capped.length} matched the pool`,
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

  const cappedIds = capped.map((r) => Number(r.story_id));
  const cappedFactors = await loadFactorsByStory(cappedIds);
  const watch_candidate_ids = capped
    .filter((r) => {
      const id = Number(r.story_id);
      const conf = r.point_in_time_confidence;
      const penalty = cappedFactors.get(id)?.penalty ?? [];
      const matchesFactor = penalty.some((f) => WATCH_PENALTY_FACTORS.has(f));
      return conf === "low" || conf === "medium" || matchesFactor;
    })
    .map((r) => Number(r.story_id));

  const shrug_candidates = await loadShrugCandidates(cutoff);

  const input: ComposerInput = {
    week_of: new Date().toISOString().slice(0, 10),
    stories,
    watch_candidate_ids,
    shrug_candidates,
    prior_theme_context,
  };

  console.log(
    `[compose] composing ${stories.length} stories; watch=${watch_candidate_ids.length} shrug=${shrug_candidates.length} prior_theme_context=${prior_theme_context.length}`,
  );
  const output = await composer.run(input);
  const storyIds = stories.map((s) => s.story_id);

  const issueId = await persistIssue(
    output,
    storyIds,
    cfg,
    editorResult,
    shrug_candidates,
  );
  console.log(
    `[compose] issue ${issueId} published: ${storyIds.length} stories, ${output.markdown.length} md chars`,
  );
}

// Build an EditorInput from the ranked pool (tier-1 count pre-computed
// so we can surface it to the editor) and call the editor stage. Returns
// the editor's full output so compose can persist cuts_summary onto the
// issue for the admin review page.
async function curateViaEditor(
  editor: ReturnType<typeof makeEditor>,
  pool: Array<{
    row: Awaited<
      ReturnType<typeof rowsForEditor>
    >[number];
    tier1: number;
    total: number;
  }>,
): Promise<{
  picks: Array<{ story_id: number; rank: number; reason: string }>;
  cuts_summary: string;
}> {
  const storyIds = pool.map((p) => Number(p.row.story_id));
  const factorsByStory = await loadFactorsByStory(storyIds);

  const input: EditorInput = {
    as_of_date: new Date().toISOString().slice(0, 10),
    stories: pool.map((p) => {
      const out = p.row.raw_output as ScorerOutput | null;
      const factors = factorsByStory.get(Number(p.row.story_id)) ?? {
        trigger: [],
        penalty: [],
      };
      return {
        story_id: Number(p.row.story_id),
        title: p.row.title,
        category:
          (p.row.category_slug as EditorInput["stories"][number]["category"]) ??
          null,
        theme_name: p.row.theme_name,
        composite: p.row.composite !== null ? Number(p.row.composite) : 0,
        zeitgeist: p.row.zeitgeist_score ?? 0,
        half_life: p.row.half_life ?? 0,
        reach: p.row.reach ?? 0,
        non_obviousness: p.row.non_obviousness ?? 0,
        confidence:
          (p.row.point_in_time_confidence as
            | EditorInput["stories"][number]["confidence"]) ?? null,
        tier1_sources: p.tier1,
        total_sources: p.total,
        theme_relationship:
          (p.row.theme_relationship as
            | EditorInput["stories"][number]["theme_relationship"]) ?? null,
        scorer_one_liner: out?.summary ?? "",
        retrodiction_12mo: out?.reasoning?.retrodiction_12mo ?? "",
        factors_trigger: factors.trigger,
        factors_penalty: factors.penalty,
      };
    }),
  };

  const result = await editor.run(input);
  console.log(
    `[compose] editor picked ${result.picks.length} stories; cuts: ${result.cuts_summary}`,
  );
  return { picks: result.picks, cuts_summary: result.cuts_summary };
}

// Typed helper so curateViaEditor's pool parameter can reference the shape.
async function rowsForEditor() {
  return db
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
      "story.non_obviousness",
      "story.composite",
      "story.point_in_time_confidence",
      "story.raw_output",
    ])
    .where("story.passed_gate", "=", true)
    .where("story.published_to_reader", "=", false)
    .orderBy("story.composite", "desc")
    .execute();
}

// Worth a shrug: scored-but-failed-gate items in the compose window
// whose penalty factors include in_circle_hype / manufactured_hype /
// controversy_flash. Ranked by how many sources carried it (higher =
// more the algorithm pushed it = better shrug candidate). Capped at 5.
async function loadShrugCandidates(
  cutoff: Date,
): Promise<ComposerInput["shrug_candidates"]> {
  const rows = await db
    .selectFrom("story_factor")
    .innerJoin("story", "story.id", "story_factor.story_id")
    .leftJoin("category", "category.id", "story.category_id")
    .select([
      "story.id as story_id",
      "story.title",
      "story.source_url",
      "story.additional_source_urls",
      "category.slug as category_slug",
      "story.raw_output",
      "story_factor.factor as penalty_factor",
      "story.passed_gate",
      "story.scored_at",
    ])
    .where("story_factor.kind", "=", "penalty")
    .where("story_factor.factor", "in", [...SHRUG_PENALTY_FACTORS])
    .where("story.ingested_at", ">=", cutoff)
    .where("story.scored_at", "is not", null)
    .where("story.passed_gate", "=", false)
    .where("story.published_to_reader", "=", false)
    .execute();

  type Agg = {
    title: string;
    source_url: string | null;
    category: string | null;
    penalty_factors: Set<string>;
    source_count: number;
    scorer_one_liner: string;
  };
  const byStory = new Map<number, Agg>();
  for (const r of rows) {
    const id = Number(r.story_id);
    const existing = byStory.get(id);
    if (existing) {
      existing.penalty_factors.add(r.penalty_factor);
      continue;
    }
    const out = readScorerOutput(r.raw_output);
    const urls = [
      ...(r.source_url ? [r.source_url] : []),
      ...(r.additional_source_urls ?? []),
    ];
    byStory.set(id, {
      title: r.title,
      source_url: r.source_url,
      category: r.category_slug ?? null,
      penalty_factors: new Set([r.penalty_factor]),
      source_count: Math.max(urls.length, 1),
      scorer_one_liner: out.summary,
    });
  }

  return [...byStory.entries()]
    .sort((a, b) => b[1].source_count - a[1].source_count)
    .slice(0, 5)
    .map(([story_id, v]) => ({
      story_id,
      title: v.title,
      source_url: v.source_url,
      category: v.category as ComposerInput["shrug_candidates"][number]["category"],
      penalty_factors: [...v.penalty_factors],
      source_count: v.source_count,
      scorer_one_liner: v.scorer_one_liner,
    }));
}

async function loadFactorsByStory(
  storyIds: number[],
): Promise<Map<number, { trigger: string[]; penalty: string[] }>> {
  const out = new Map<number, { trigger: string[]; penalty: string[] }>();
  if (storyIds.length === 0) return out;
  const rows = await db
    .selectFrom("story_factor")
    .select(["story_id", "kind", "factor"])
    .where("story_id", "in", storyIds)
    .where("kind", "in", ["trigger", "penalty"])
    .execute();
  for (const r of rows) {
    const id = Number(r.story_id);
    const bucket = out.get(id) ?? { trigger: [], penalty: [] };
    if (r.kind === "trigger") bucket.trigger.push(r.factor);
    else if (r.kind === "penalty") bucket.penalty.push(r.factor);
    out.set(id, bucket);
  }
  return out;
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
  editorResult: {
    picks: Array<{ story_id: number; rank: number; reason: string }>;
    cuts_summary: string;
  },
  shrugCandidates: ComposerInput["shrug_candidates"],
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
        editor_output_jsonb: JSON.stringify(editorResult) as never,
        shrug_candidates_jsonb: JSON.stringify(shrugCandidates) as never,
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
    "editor.model_id",
    "editor.prompt_version",
    "editor.max_tokens",
    "editor.pool_size",
  ] as const;
  for (const k of required) {
    if (map[k] === undefined) throw new Error(`missing config key: ${k}`);
  }
  return map as ConfigMap;
}
