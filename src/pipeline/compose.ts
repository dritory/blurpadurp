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
  ComposerItem,
  ComposerOutput,
} from "../shared/composer-schema.ts";
import { normalizePick } from "../shared/editor-schema.ts";
import type { EditorInput, EditorOutput } from "../shared/editor-schema.ts";
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
      "story.published_at",
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
  const normalizedPicks = editorResult.picks
    .map(normalizePick)
    .sort((a, b) => a.rank - b.rank);
  const byId = new Map(pool.map((p) => [Number(p.row.story_id), p.row]));

  type PoolRow = NonNullable<ReturnType<typeof byId.get>>;

  // Materialize each normalized pick into a ComposerItem (stories sorted
  // chronologically). Picks whose ids can't be resolved from the pool
  // are dropped; partial arcs degrade to what matched.
  const builtItems: Array<{
    item: ComposerItem;
    constituentRows: PoolRow[];
  }> = [];
  for (const p of normalizedPicks) {
    const matched = p.story_ids
      .map((sid) => byId.get(sid))
      .filter((r): r is PoolRow => r !== undefined);
    if (matched.length === 0) continue;
    matched.sort((a, b) => {
      const ta = a.published_at?.getTime() ?? Number.POSITIVE_INFINITY;
      const tb = b.published_at?.getTime() ?? Number.POSITIVE_INFINITY;
      return ta - tb;
    });
    builtItems.push({
      constituentRows: matched,
      item: {
        kind: p.is_arc && matched.length > 1 ? "arc" : "single",
        rank: p.rank,
        lead_story_id: byId.has(p.lead_story_id)
          ? p.lead_story_id
          : Number(matched[0]!.story_id),
        reason: p.reason,
        stories: matched.map((r) => {
          const out = readScorerOutput(r.raw_output);
          return {
            story_id: Number(r.story_id),
            title: r.title,
            summary: r.summary,
            source_url: r.source_url,
            additional_source_urls: r.additional_source_urls ?? [],
            category: (r.category_slug as ComposerItem["stories"][number]["category"]) ?? null,
            theme_name: r.theme_name,
            theme_relationship:
              (r.theme_relationship as ComposerItem["stories"][number]["theme_relationship"]) ?? null,
            zeitgeist_score: r.zeitgeist_score ?? 0,
            half_life: r.half_life ?? 0,
            reach: r.reach ?? 0,
            composite: r.composite !== null ? Number(r.composite) : 0,
            scorer_one_liner: out.summary,
            retrodiction_12mo: out.retrodiction,
            published_at: r.published_at?.toISOString() ?? null,
          };
        }),
      },
    });
  }

  if (builtItems.length === 0) {
    console.log("[compose] editor returned no valid picks — aborting");
    return;
  }

  // Partition into the four fixed sections. Rules:
  // - Arcs ALWAYS go to conversation/worth_knowing (split by rank); an
  //   arc is by definition a continuing multi-story thread, not an
  //   emerging/uncertain lead.
  // - Singles whose lead story meets "watch" criteria (low/medium
  //   confidence OR an unreplicated/preclinical_only/insufficient_evidence
  //   penalty factor) go to worth_watching regardless of rank.
  // - Other singles: rank ≤ CONVERSATION_TOP_N → conversation, else
  //   worth_knowing.
  const allRows = builtItems.flatMap((b) => b.constituentRows);
  const leadIds = builtItems.map((b) => b.item.lead_story_id);
  const allFactors = await loadFactorsByStory(
    [...new Set([...leadIds, ...allRows.map((r) => Number(r.story_id))])],
  );

  const CONVERSATION_TOP_N = 5;
  const conversation: ComposerItem[] = [];
  const worth_knowing: ComposerItem[] = [];
  const worth_watching: ComposerItem[] = [];

  for (const b of builtItems) {
    const leadRow = byId.get(b.item.lead_story_id) ?? b.constituentRows[0]!;
    const conf = leadRow.point_in_time_confidence;
    const penalty = allFactors.get(b.item.lead_story_id)?.penalty ?? [];
    const matchesWatch = penalty.some((f) => WATCH_PENALTY_FACTORS.has(f));
    const watchWorthy =
      b.item.kind === "single" &&
      (conf === "low" || conf === "medium" || matchesWatch);
    if (watchWorthy) {
      worth_watching.push(b.item);
    } else if (b.item.rank <= CONVERSATION_TOP_N) {
      conversation.push(b.item);
    } else {
      worth_knowing.push(b.item);
    }
  }

  const prior_theme_context = await loadPriorThemeContext(
    allRows.map((r) => r.theme_id).filter((id): id is number => id !== null),
  );

  const shrug = await loadShrugCandidates(cutoff);

  const input: ComposerInput = {
    week_of: new Date().toISOString().slice(0, 10),
    conversation,
    worth_knowing,
    worth_watching,
    shrug,
    prior_theme_context,
  };

  const arcCount = builtItems.filter((b) => b.item.kind === "arc").length;
  console.log(
    `[compose] composing conv=${conversation.length} know=${worth_knowing.length} watch=${worth_watching.length} shrug=${shrug.length} arcs=${arcCount} prior=${prior_theme_context.length}`,
  );
  const output = await composer.run(input);

  // Collect every story_id that appears in ANY section item — that's
  // what gets persisted on the issue and flipped to published_to_reader.
  const storyIds = Array.from(
    new Set(
      [conversation, worth_knowing, worth_watching]
        .flat()
        .flatMap((it) => it.stories.map((s) => s.story_id)),
    ),
  );

  const issueId = await persistIssue(
    output,
    storyIds,
    cfg,
    editorResult,
    shrug,
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
): Promise<EditorOutput> {
  const storyIds = pool.map((p) => Number(p.row.story_id));
  const factorsByStory = await loadFactorsByStory(storyIds);

  const editorStories: EditorInput["stories"] = pool.map((p) => {
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
      theme_id: p.row.theme_id !== null ? Number(p.row.theme_id) : null,
      theme_name: p.row.theme_name,
      published_at: p.row.published_at?.toISOString() ?? null,
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
  });

  const input: EditorInput = {
    as_of_date: new Date().toISOString().slice(0, 10),
    stories: editorStories,
    themes: buildThemesDigest(pool, editorStories),
  };

  const result = await editor.run(input);
  console.log(
    `[compose] editor picked ${result.picks.length} stories; cuts: ${result.cuts_summary}`,
  );
  return { picks: result.picks, cuts_summary: result.cuts_summary };
}

// Build the themes digest from the editor pool. Every theme with at
// least one story in the pool yields one entry; story_ids are sorted
// chronologically (earliest published_at first, null dates last).
// day_span = calendar-day distance between first and last; same-day = 0.
function buildThemesDigest(
  pool: Array<{
    row: Awaited<ReturnType<typeof rowsForEditor>>[number];
    tier1: number;
    total: number;
  }>,
  stories: EditorInput["stories"],
): EditorInput["themes"] {
  const byId = new Map(stories.map((s) => [s.story_id, s] as const));
  const tier1ById = new Map(
    pool.map((p) => [Number(p.row.story_id), p.tier1] as const),
  );
  const grouped = new Map<
    number,
    { theme_name: string; category: string | null; storyIds: number[] }
  >();
  for (const s of stories) {
    if (s.theme_id === null || s.theme_name === null) continue;
    const entry =
      grouped.get(s.theme_id) ??
      ({
        theme_name: s.theme_name,
        category: s.category,
        storyIds: [],
      } as const);
    entry.storyIds.push(s.story_id);
    grouped.set(s.theme_id, {
      theme_name: entry.theme_name,
      category: entry.category,
      storyIds: entry.storyIds,
    });
  }

  const digest: EditorInput["themes"] = [];
  const DAY_MS = 24 * 3600_000;
  for (const [theme_id, g] of grouped) {
    const sorted = [...g.storyIds].sort((a, b) => {
      const pa = byId.get(a)?.published_at ?? null;
      const pb = byId.get(b)?.published_at ?? null;
      const ta = pa !== null ? new Date(pa).getTime() : Number.POSITIVE_INFINITY;
      const tb = pb !== null ? new Date(pb).getTime() : Number.POSITIVE_INFINITY;
      return ta - tb;
    });
    const firstS = byId.get(sorted[0]!);
    const lastS = byId.get(sorted[sorted.length - 1]!);
    const first_published_at = firstS?.published_at ?? null;
    const last_published_at = lastS?.published_at ?? null;
    let day_span = 0;
    if (first_published_at !== null && last_published_at !== null) {
      day_span = Math.floor(
        (new Date(last_published_at).getTime() -
          new Date(first_published_at).getTime()) /
          DAY_MS,
      );
    }
    let composite_max = 0;
    let composite_sum = 0;
    let tier1_sources_total = 0;
    for (const sid of sorted) {
      const s = byId.get(sid);
      if (s === undefined) continue;
      if (s.composite > composite_max) composite_max = s.composite;
      composite_sum += s.composite;
      tier1_sources_total += tier1ById.get(sid) ?? 0;
    }
    digest.push({
      theme_id,
      theme_name: g.theme_name,
      category: g.category as EditorInput["themes"][number]["category"],
      story_ids: sorted,
      first_published_at,
      last_published_at,
      day_span,
      composite_max,
      composite_sum,
      tier1_sources_total,
    });
  }

  // Surface likely arcs first: multi-story themes sorted by day_span
  // desc then composite_sum desc. Single-story themes follow, by
  // composite_max desc.
  digest.sort((a, b) => {
    const aArc = a.story_ids.length >= 2 ? 1 : 0;
    const bArc = b.story_ids.length >= 2 ? 1 : 0;
    if (aArc !== bArc) return bArc - aArc;
    if (aArc === 1 && bArc === 1) {
      if (b.day_span !== a.day_span) return b.day_span - a.day_span;
      return b.composite_sum - a.composite_sum;
    }
    return b.composite_max - a.composite_max;
  });
  return digest;
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
      "story.published_at",
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
  editorResult: EditorOutput,
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
