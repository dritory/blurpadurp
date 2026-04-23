// Pipeline stage: compose.
// Pulls stories that passed the gate and haven't been published yet,
// calls the composer, persists an `issue` and marks the stories as
// published. For v0 there's a single cadence — one issue per run,
// containing every currently-passing, unpublished story.

import { sql } from "kysely";

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

  // Preload per-theme metadata for every theme in the pool — used both
  // by the editor's themes digest (trajectory, prior-publication count)
  // and the composer's timelines.
  const poolThemeIds = [
    ...new Set(
      pool
        .map((p) => p.row.theme_id)
        .filter((id): id is number => id !== null)
        .map((id) => Number(id)),
    ),
  ];
  const poolThemeMeta = await loadThemeMeta(poolThemeIds);

  const { output: editorResult, input: editorInput } = await curateViaEditor(
    editor,
    pool,
    poolThemeMeta,
  );
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

  // Partition rules:
  // - Arcs always route by rank (they're continuing threads, never
  //   "still developing" placeholders).
  // - Singles route by rank too: 1..CONVERSATION_TOP_N → conversation,
  //   next ..WORTH_KNOWING_TOP_N → worth_knowing, 11+ → worth_watching.
  // - Safety-net override: any item whose lead story has
  //   confidence = "low" OR an evidence-weak penalty factor
  //   (unreplicated, preclinical_only, insufficient_evidence) drops to
  //   worth_watching regardless of rank.
  const allRows = builtItems.flatMap((b) => b.constituentRows);
  const leadIds = builtItems.map((b) => b.item.lead_story_id);
  const allFactors = await loadFactorsByStory(
    [...new Set([...leadIds, ...allRows.map((r) => Number(r.story_id))])],
  );

  const CONVERSATION_TOP_N = 5;
  const WORTH_KNOWING_TOP_N = 10;
  const conversation: ComposerItem[] = [];
  const worth_knowing: ComposerItem[] = [];
  const worth_watching: ComposerItem[] = [];

  for (const b of builtItems) {
    const leadRow = byId.get(b.item.lead_story_id) ?? b.constituentRows[0]!;
    const conf = leadRow.point_in_time_confidence;
    const penalty = allFactors.get(b.item.lead_story_id)?.penalty ?? [];
    const matchesWatch = penalty.some((f) => WATCH_PENALTY_FACTORS.has(f));
    const uncertaintyOverride =
      b.item.kind === "single" && (conf === "low" || matchesWatch);
    if (uncertaintyOverride) {
      worth_watching.push(b.item);
    } else if (b.item.rank <= CONVERSATION_TOP_N) {
      conversation.push(b.item);
    } else if (b.item.rank <= WORTH_KNOWING_TOP_N) {
      worth_knowing.push(b.item);
    } else {
      worth_watching.push(b.item);
    }
  }

  // Build per-theme metadata + cross-issue timelines. The metadata
  // feeds the composer's ability to anchor arcs ("three weeks in",
  // "since last month's X") instead of treating each week fresh.
  const renderedItems = [
    ...conversation,
    ...worth_knowing,
    ...worth_watching,
  ];
  const themeIdsInItems = [
    ...new Set(
      renderedItems
        .flatMap((it) => it.stories)
        .map((s) => {
          const row = byId.get(s.story_id);
          return row?.theme_id !== null && row?.theme_id !== undefined
            ? Number(row.theme_id)
            : null;
        })
        .filter((id): id is number => id !== null),
    ),
  ];
  const themeMeta = await loadThemeMeta(themeIdsInItems);

  const currentIssueStoriesByTheme = new Map<number, CurrentIssueStory[]>();
  for (const it of renderedItems) {
    for (const s of it.stories) {
      const row = byId.get(s.story_id);
      if (!row || row.theme_id === null) continue;
      const tid = Number(row.theme_id);
      const date = (s.published_at ?? "").slice(0, 10);
      if (date === "") continue;
      const entry: CurrentIssueStory = {
        theme_id: tid,
        story_id: s.story_id,
        date,
        one_liner: s.scorer_one_liner,
      };
      const list = currentIssueStoriesByTheme.get(tid) ?? [];
      list.push(entry);
      currentIssueStoriesByTheme.set(tid, list);
    }
  }

  const theme_timelines = await loadThemeTimelines(
    themeMeta,
    currentIssueStoriesByTheme,
  );

  const shrug = await loadShrugCandidates(cutoff);

  // Build synthesis_themes: one entry per distinct theme touched by
  // conversation + worth_knowing items (worth_watching is typically
  // too speculative to anchor a synthesis). Each entry's shape uses
  // the editor's reason if available (the one-line arc headline),
  // or falls back to the lead story's scorer one-liner.
  const synthesisItems = [...conversation, ...worth_knowing];
  const synthesisByTheme = new Map<
    number,
    {
      theme_name: string;
      category: string | null;
      shape: string;
      is_arc: boolean;
    }
  >();
  for (const it of synthesisItems) {
    const leadRow = byId.get(it.lead_story_id);
    const tid =
      leadRow?.theme_id !== null && leadRow?.theme_id !== undefined
        ? Number(leadRow.theme_id)
        : null;
    if (tid === null) continue;
    const existing = synthesisByTheme.get(tid);
    const theme_name =
      leadRow?.theme_name ?? it.stories[0]?.theme_name ?? `theme #${tid}`;
    const category = it.stories[0]?.category ?? null;
    const shape =
      it.reason.length > 0
        ? it.reason
        : it.stories[0]?.scorer_one_liner ?? theme_name;
    if (existing === undefined || (it.kind === "arc" && !existing.is_arc)) {
      synthesisByTheme.set(tid, {
        theme_name,
        category,
        shape,
        is_arc: it.kind === "arc",
      });
    }
  }
  const synthesis_themes: ComposerInput["synthesis_themes"] =
    synthesisByTheme.size >= 2
      ? [...synthesisByTheme.entries()].map(([tid, entry]) => {
          const meta = themeMeta.get(tid);
          return {
            theme_name: entry.theme_name,
            category: entry.category as ComposerInput["synthesis_themes"][number]["category"],
            shape: entry.shape,
            is_arc: entry.is_arc,
            trajectory: meta?.trajectory ?? "new",
          };
        })
      : [];

  const input: ComposerInput = {
    week_of: new Date().toISOString().slice(0, 10),
    conversation,
    worth_knowing,
    worth_watching,
    shrug,
    theme_timelines,
    synthesis_themes,
  };

  const arcCount = builtItems.filter((b) => b.item.kind === "arc").length;
  const deepArcs = theme_timelines.filter((t) => t.n_prior_publications >= 2).length;
  console.log(
    `[compose] composing conv=${conversation.length} know=${worth_knowing.length} watch=${worth_watching.length} shrug=${shrug.length} arcs=${arcCount} themes=${theme_timelines.length} (${deepArcs} with 2+ prior issues)`,
  );
  const output = await composer.run(input);

  // Collect every story_id that appears in ANY section (including shrug)
  // — that's what gets persisted on the issue and flipped to
  // published_to_reader. Marking shrug items as published too prevents
  // them from recurring in the next week's shrug pool.
  const mainStoryIds = Array.from(
    new Set(
      [conversation, worth_knowing, worth_watching]
        .flat()
        .flatMap((it) => it.stories.map((s) => s.story_id)),
    ),
  );
  const shrugStoryIds = shrug.map((s) => s.story_id);
  const storyIds = Array.from(new Set([...mainStoryIds, ...shrugStoryIds]));

  const issueId = await persistIssue(
    output,
    storyIds,
    cfg,
    editorInput,
    editorResult,
    shrug,
    input,
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
  themeMeta: Map<number, ThemeMeta>,
): Promise<{ output: EditorOutput; input: EditorInput }> {
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
      structural_importance: out?.scores?.structural_importance ?? 0,
      base_rate_per_year: out?.reasoning?.base_rate_per_year ?? 0,
      confidence:
        (p.row.point_in_time_confidence as
          | EditorInput["stories"][number]["confidence"]) ?? null,
      tier1_sources: p.tier1,
      total_sources: p.total,
      theme_relationship:
        (p.row.theme_relationship as
          | EditorInput["stories"][number]["theme_relationship"]) ?? null,
      scorer_one_liner: out?.summary ?? "",
      steelman_important: out?.reasoning?.steelman_important ?? "",
      retrodiction_12mo: out?.reasoning?.retrodiction_12mo ?? "",
      factors_trigger: factors.trigger,
      factors_penalty: factors.penalty,
    };
  });

  const input: EditorInput = {
    as_of_date: new Date().toISOString().slice(0, 10),
    pool_composition: buildPoolComposition(editorStories),
    stories: editorStories,
    themes: buildThemesDigest(pool, editorStories, themeMeta),
  };

  const result = await editor.run(input);
  console.log(
    `[compose] editor picked ${result.picks.length} stories; cuts: ${result.cuts_summary}`,
  );
  return {
    output: { picks: result.picks, cuts_summary: result.cuts_summary },
    input,
  };
}

// Pre-compute pool shape for the editor: category distribution,
// confidence distribution, and explicit lists of the two cohorts
// where editorial judgment matters most — quiet-but-significant
// (Worth-knowing candidates) and loud-but-insignificant (the
// zeitgeist stenography trap).
const QUIET_ZEITGEIST_MAX = 2;
const SIGNIFICANT_STRUCTURAL_MIN = 4;
const LOUD_ZEITGEIST_MIN = 4;
const INSIGNIFICANT_STRUCTURAL_MAX = 2;

function buildPoolComposition(
  stories: EditorInput["stories"],
): EditorInput["pool_composition"] {
  const byCategory: Record<string, number> = {};
  const byConfidence = { low: 0, medium: 0, high: 0 };
  const quiet: number[] = [];
  const loud: number[] = [];
  for (const s of stories) {
    const cat = s.category ?? "unknown";
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    if (s.confidence === "low") byConfidence.low += 1;
    else if (s.confidence === "medium") byConfidence.medium += 1;
    else if (s.confidence === "high") byConfidence.high += 1;
    if (
      s.zeitgeist <= QUIET_ZEITGEIST_MAX &&
      s.structural_importance >= SIGNIFICANT_STRUCTURAL_MIN
    ) {
      quiet.push(s.story_id);
    }
    if (
      s.zeitgeist >= LOUD_ZEITGEIST_MIN &&
      s.structural_importance <= INSIGNIFICANT_STRUCTURAL_MAX
    ) {
      loud.push(s.story_id);
    }
  }
  return {
    total: stories.length,
    by_category: byCategory,
    by_confidence: byConfidence,
    quiet_but_significant: quiet,
    loud_but_insignificant: loud,
  };
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
  themeMeta: Map<number, ThemeMeta>,
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
    const entry = grouped.get(s.theme_id) ?? {
      theme_name: s.theme_name,
      category: s.category,
      storyIds: [] as number[],
    };
    entry.storyIds.push(s.story_id);
    grouped.set(s.theme_id, entry);
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
    const meta = themeMeta.get(theme_id);
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
      age_days: meta?.age_days ?? 0,
      n_prior_publications: meta?.n_prior_publications ?? 0,
      trajectory: meta?.trajectory ?? "new",
      is_long_running: meta?.is_long_running ?? false,
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

const PENALTY_LABELS: Record<string, string> = {
  in_circle_hype: "in-circle hype",
  manufactured_hype: "manufactured hype",
  controversy_flash: "48-hour controversy",
};
function humanizePenaltyFactor(f: string): string {
  return PENALTY_LABELS[f] ?? f.replace(/_/g, " ");
}

// Worth a shrug: scored-but-failed-gate items in the compose window
// whose penalty factors include in_circle_hype / manufactured_hype /
// controversy_flash. Ranked by how many sources carried it (higher =
// more the algorithm pushed it = better shrug candidate). Capped at 5.
async function loadShrugCandidates(
  cutoff: Date,
): Promise<ComposerInput["shrug"]> {
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
      category: v.category as ComposerInput["shrug"][number]["category"],
      penalty_factors: [...v.penalty_factors].map(humanizePenaltyFactor),
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

// Full per-theme timelines for the composer. For every theme_id the
// composer's items touch, load up to TIMELINE_MAX_ENTRIES prior
// published stories plus any current-issue constituents, merge, sort
// descending by date, and annotate with in_current_issue.
const TIMELINE_MAX_ENTRIES = 12;
const TIMELINE_LOOKBACK_DAYS = 90;

interface CurrentIssueStory {
  theme_id: number;
  story_id: number;
  date: string;
  one_liner: string;
}

async function loadThemeTimelines(
  themeMeta: Map<number, ThemeMeta>,
  currentIssueStoriesByTheme: Map<number, CurrentIssueStory[]>,
): Promise<ComposerInput["theme_timelines"]> {
  const themeIds = [...themeMeta.keys()];
  if (themeIds.length === 0) return [];

  const since = new Date(Date.now() - TIMELINE_LOOKBACK_DAYS * 24 * 3600_000);
  const priorRows = await db
    .selectFrom("story")
    .select([
      "theme_id",
      "published_to_reader_at",
      "raw_output",
    ])
    .where("theme_id", "in", themeIds)
    .where("published_to_reader", "=", true)
    .where("published_to_reader_at", ">=", since)
    .orderBy("published_to_reader_at", "desc")
    .execute();

  const priorByTheme = new Map<
    number,
    Array<{ date: string; one_liner: string }>
  >();
  for (const r of priorRows) {
    if (r.theme_id === null) continue;
    const tid = Number(r.theme_id);
    const list = priorByTheme.get(tid) ?? [];
    const scored = readScorerOutput(r.raw_output);
    list.push({
      date: r.published_to_reader_at?.toISOString().slice(0, 10) ?? "",
      one_liner: scored.summary,
    });
    priorByTheme.set(tid, list);
  }

  const out: ComposerInput["theme_timelines"] = [];
  for (const [tid, meta] of themeMeta) {
    const current = currentIssueStoriesByTheme.get(tid) ?? [];
    const prior = priorByTheme.get(tid) ?? [];
    const entries = [
      ...current.map((c) => ({
        date: c.date,
        one_liner: c.one_liner,
        in_current_issue: true,
      })),
      ...prior.map((p) => ({
        date: p.date,
        one_liner: p.one_liner,
        in_current_issue: false,
      })),
    ]
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, TIMELINE_MAX_ENTRIES);

    out.push({
      theme_id: tid,
      theme_name: meta.theme_name,
      category: meta.category as ComposerInput["theme_timelines"][number]["category"],
      trajectory: meta.trajectory,
      is_long_running: meta.is_long_running,
      n_prior_publications: meta.n_prior_publications,
      entries,
    });
  }
  return out;
}

export interface ThemeMeta {
  theme_id: number;
  theme_name: string;
  category: string | null;
  age_days: number;
  n_prior_publications: number;
  trajectory: "new" | "rising" | "stable" | "falling";
  is_long_running: boolean;
}

// Load per-theme metadata used by both editor (digest) and composer
// (timelines). One pass for trajectory math; one pass for prior-issue
// counts. Scales linearly with distinct-theme count in the pool.
async function loadThemeMeta(themeIds: number[]): Promise<Map<number, ThemeMeta>> {
  const out = new Map<number, ThemeMeta>();
  if (themeIds.length === 0) return out;

  const rows = await db
    .selectFrom("theme")
    .leftJoin("category", "category.id", "theme.category_id")
    .select([
      "theme.id",
      "theme.name",
      "category.slug as category_slug",
      "theme.first_seen_at",
      "theme.n_stories_published",
      "theme.rolling_composite_avg",
      "theme.rolling_composite_30d",
      "theme.is_long_running",
    ])
    .where("theme.id", "in", themeIds)
    .execute();

  // Count distinct prior issues per theme — an issue counts if any of
  // its story_ids has that theme. One SQL pass avoids N queries.
  const priorCounts = await db
    .selectFrom("issue")
    .innerJoin("story", (join) =>
      join.on(sql`story.id = ANY(issue.story_ids)`),
    )
    .select([
      "story.theme_id",
      sql<string>`count(distinct issue.id)`.as("n"),
    ])
    .where("story.theme_id", "in", themeIds)
    .groupBy("story.theme_id")
    .execute();
  const priorCountMap = new Map<number, number>();
  for (const r of priorCounts) {
    if (r.theme_id === null) continue;
    priorCountMap.set(Number(r.theme_id), Number(r.n));
  }

  const now = Date.now();
  for (const r of rows) {
    const tid = Number(r.id);
    const avg =
      r.rolling_composite_avg !== null ? Number(r.rolling_composite_avg) : null;
    const d30 =
      r.rolling_composite_30d !== null ? Number(r.rolling_composite_30d) : null;
    const n = r.n_stories_published;
    let trajectory: ThemeMeta["trajectory"];
    if (n < 3 || avg === null || d30 === null) {
      trajectory = "new";
    } else if (avg === 0) {
      trajectory = "stable";
    } else {
      const ratio = d30 / avg;
      if (ratio > 1.1) trajectory = "rising";
      else if (ratio < 0.9) trajectory = "falling";
      else trajectory = "stable";
    }
    out.set(tid, {
      theme_id: tid,
      theme_name: r.name,
      category: r.category_slug,
      age_days: Math.max(
        0,
        Math.floor((now - r.first_seen_at.getTime()) / (24 * 3600_000)),
      ),
      n_prior_publications: priorCountMap.get(tid) ?? 0,
      trajectory,
      is_long_running: r.is_long_running,
    });
  }
  return out;
}

async function persistIssue(
  output: ComposerOutput,
  storyIds: number[],
  cfg: ConfigMap,
  editorInput: EditorInput,
  editorResult: EditorOutput,
  shrugCandidates: ComposerInput["shrug"],
  composerInput: ComposerInput,
): Promise<number> {
  return db.transaction().execute(async (tx) => {
    const issue = await tx
      .insertInto("issue")
      .values({
        is_event_driven: false,
        title: output.title,
        composed_markdown: output.markdown,
        composed_html: output.html,
        story_ids: storyIds,
        composer_prompt_version: cfg["composer.prompt_version"],
        composer_model_id: cfg["composer.model_id"],
        editor_input_jsonb: JSON.stringify(editorInput) as never,
        editor_output_jsonb: JSON.stringify(editorResult) as never,
        shrug_candidates_jsonb: JSON.stringify(shrugCandidates) as never,
        composer_input_jsonb: JSON.stringify(composerInput) as never,
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
