// Pipeline stage: compose.
// Pulls stories that passed the gate and haven't been published yet,
// calls the composer, persists an `issue` and marks the stories as
// published. For v0 there's a single cadence — one issue per run,
// containing every currently-passing, unpublished story.

import { sql } from "kysely";
import { getConfigNumber } from "../shared/config-store.ts";

import { makeComposer } from "../ai/composer.ts";
import { makeEditor } from "../ai/editor.ts";
import { db } from "../db/index.ts";
import { hydrateRawOutput } from "../shared/cold-tier.ts";
import { notifyAdmin, renderAdminNotice } from "../shared/admin-notify.ts";
import { getEnvOptional } from "../shared/env.ts";
import { loadSystemPromptText, type PromptMode } from "../shared/prompts.ts";
import { selectEditorPool } from "../shared/editor-pool.ts";
import { loadThemeClusters } from "../shared/theme-cluster-store.ts";
import type { ThemeCluster } from "../shared/theme-cluster.ts";
import {
  loadRecentCoverage,
  type ThemeCoverage,
} from "../shared/recent-coverage.ts";
import { countTier1 } from "../shared/source-tiers.ts";
import type {
  ComposerInput,
  ComposerItem,
  ComposerOutput,
} from "../shared/composer-schema.ts";
import { normalizePick } from "../shared/editor-schema.ts";
import type { EditorInput, EditorOutput } from "../shared/editor-schema.ts";
import { diversifyPicks } from "./compose-diversity.ts";
import { isLockHeld, withLock } from "../shared/pipeline-lock.ts";
import { lintGloss } from "../shared/gloss-lint.ts";
import { bumpGlossHits, loadGlossLists } from "../shared/gloss-store.ts";
import type { ScorerOutput } from "../shared/scoring-schema.ts";
import { routeSection } from "./compose-partition.ts";

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

// One-week freshness gate. Stories whose published_at sits outside this
// window are excluded from the editor pool and the shrug pool — even if
// they were just ingested. Undated items (published_at IS NULL) fall
// back to ingested_at; same window applies, so re-ingested archive
// URLs can't smuggle ancient material into the brief.
const COMPOSE_STORY_MAX_AGE_MS = 7 * 24 * 3600_000;

// Catch-up ("retro") composition. After a gap in publishing, everything
// older than the window above is invisible to the editor and never
// ships — it simply ages out. A catch-up run adds a bounded set of
// older stories to the pool.
//
// It deliberately does NOT widen the window above. The gate is
// explicitly "discussed NOW" (docs/scoring-prompt.md), so re-ranking
// three-week-old stories by composite sorts them by how loud they were
// three weeks ago — a stale trending list, which is the algorithmic
// recency artifact this product exists to reject. Catch-up items are
// instead ranked on structural_importance × half_life, the durable
// axis, which is already scored on every story and deliberately does
// NOT enter the composite (docs/scoring.md).
//
// It also ignores passed_gate. A gate-failing story can be highly
// structural — that's the quiet×significant quadrant the editor rubric
// already asks for, and the gate was measuring the wrong thing for
// these items anyway.
const DEFAULT_RETRO_WINDOW_DAYS = 21;
const DEFAULT_RETRO_MAX_ITEMS = 8;

export interface RetroOptions {
  // Explicit story ids chosen by the operator on /admin/release. When
  // present, these are the catch-up pool verbatim (still age- and
  // unpublished-filtered) instead of the ranked top-N. Picking which
  // quiet items still deserve air is editorial judgment, so the console
  // offers it rather than trusting a ranking function.
  storyIds?: number[];
}

export type ConfigMap = {
  "composer.model_id": string;
  "composer.prompt_version": string;
  "composer.max_tokens": number;
  "editor.model_id": string;
  "editor.prompt_version": string;
  "editor.max_tokens": number;
  "editor.pool_size": number;
  "editor.pool_max_themes": number;
  "editor.pool_max_category_fraction": number;
  // Narrative clustering (see shared/theme-cluster.ts). The threshold is
  // the cosine bar at which two themes count as one running story; the
  // three caps are how much of the pool, the issue, and the lead section
  // one such story may occupy.
  "editor.cluster_threshold": number;
  "editor.pool_max_cluster_fraction": number;
  "compose.max_picks_per_cluster": number;
  "compose.max_per_section_per_cluster": number;
  // How many prior published issues the editor and composer are shown,
  // so neither re-tells the reader something they already read.
  "compose.recent_coverage_issues": number;
  "compose.min_publish_gap_hours": number;
};

// `retro` turns this into a catch-up run: the pool gains a bounded set
// of older, durably-significant stories that the 7-day window would
// otherwise strand. Set from /admin/release (via pipeline_force_run
// .args) or `bun run cli compose --retro`; the scheduled weekly run
// never passes it.
export async function compose(retro?: RetroOptions): Promise<void> {
  if (await isLockHeld("score")) {
    console.log("[compose] score is still running, skipping");
    return;
  }
  await withLock("compose", 15 * 60_000, () => runCompose(retro));
}

async function runCompose(retro?: RetroOptions): Promise<void> {
  // One open draft at a time. If a previous run produced a draft that
  // hasn't been published or discarded yet, bail — the operator needs
  // to resolve it. Prevents the next cron firing from stealing fresh
  // stories into a parallel draft.
  const existingDraft = await db
    .selectFrom("issue")
    .select("id")
    .where("is_draft", "=", true)
    .executeTakeFirst();
  if (existingDraft !== undefined) {
    console.log(
      `[compose] open draft #${existingDraft.id} exists — publish or discard it first, skipping`,
    );
    return;
  }

  // Cadence guard. Once a draft is published, refuse to start another
  // regular compose until the configured gap has elapsed since the last
  // non-event-driven publication. Drafts don't count (they didn't ship);
  // event-driven issues don't count (they're a separate cadence).
  const cfgForGap = await loadConfig();
  const gapHours = cfgForGap["compose.min_publish_gap_hours"];
  const lastPublished = await db
    .selectFrom("issue")
    .select(({ fn }) => fn.max("published_at").as("last"))
    .where("is_draft", "=", false)
    .where("is_event_driven", "=", false)
    .executeTakeFirst();
  // A catch-up run is an explicit operator action, not the cadence
  // firing, so the gap guard doesn't apply — it exists to stop the
  // schedule double-firing. The open-draft guard above still does:
  // that one is about correctness, not timing.
  if (lastPublished?.last && retro === undefined) {
    const ageHours = (Date.now() - lastPublished.last.getTime()) / 3600_000;
    if (ageHours < gapHours) {
      console.log(
        `[compose] last regular issue published ${ageHours.toFixed(1)}h ago (gap=${gapHours}h); skipping`,
      );
      return;
    }
  }

  const draft = await produceDraft("live", retro);
  if (draft === null) return;

  // Gloss-lint the fresh draft: log un-glossed acronyms/jargon and bump
  // per-term hit counts so the operator can see (at /admin/gloss-terms)
  // which jargon recurs. Advisory — never blocks. The /admin/review page
  // re-lints read-only to render the panel. Best-effort; a lint failure
  // must not sink an otherwise-good compose.
  try {
    const lists = await loadGlossLists();
    const findings = lintGloss(
      draft.output.markdown,
      lists.jargon,
      lists.ignored,
    );
    const flagged = findings.filter((f) => !f.glossed);
    if (flagged.length > 0) {
      const acronyms = flagged.filter((f) => f.kind === "acronym").map((f) => f.term);
      const jargon = flagged.filter((f) => f.kind === "jargon").map((f) => f.term);
      console.log(
        `[compose] gloss-lint: ${flagged.length} term(s) look un-glossed` +
          (acronyms.length > 0 ? ` — acronyms: ${acronyms.join(", ")}` : "") +
          (jargon.length > 0 ? ` — jargon: ${jargon.join(", ")}` : ""),
      );
      await bumpGlossHits(jargon);
    }
  } catch (e) {
    console.warn(
      `[compose] gloss-lint failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const issueId = await persistIssue(
    draft.output,
    draft.storyIds,
    draft.cfg,
    draft.editorInput,
    draft.editorResult,
    draft.shrug,
    draft.composerInput,
  );
  console.log(
    `[compose] draft issue ${issueId} created: ${draft.storyIds.length} stories, ${draft.output.markdown.length} md chars — publish via /admin/review/${issueId}`,
  );

  const publicUrl =
    getEnvOptional("BLURPADURP_PUBLIC_URL") ?? "http://localhost:3000";
  const reviewUrl = `${publicUrl}/admin/review/${issueId}`;
  const notice = renderAdminNotice({
    heading: `New draft #${issueId} ready for review`,
    bodyLines: [
      draft.output.title.length > 0
        ? `Title: ${draft.output.title}`
        : `Title: (untitled)`,
      `${draft.storyIds.length} stories selected.`,
      `Review, edit, or publish before the next dispatch tick.`,
    ],
    ctaLabel: "Open review page",
    ctaUrl: reviewUrl,
  });
  await notifyAdmin({
    subject: `[blurpadurp] New draft #${issueId} ready for review`,
    html: notice.html,
    text: notice.text,
  });
}

// Result of a full editor → composer run. Returned by produceDraft so
// both the initial compose and re-edit share the same code path.
export interface DraftProduction {
  output: ComposerOutput;
  storyIds: number[];
  cfg: ConfigMap;
  editorInput: EditorInput;
  editorResult: EditorOutput;
  shrug: ComposerInput["shrug"];
  composerInput: ComposerInput;
}

// Run the pool query + editor + composer. Returns null if the pool is
// empty or the editor produced no valid picks — caller decides what to
// do (compose entry logs and bails; re-edit would surface an error).
//
// mode='live' reads prompts from docs/*-prompt.md; mode='replay' checks
// prompt_draft first so admin-staged edits drive the re-edit. The
// returned composer_prompt_version is tagged with "-staged" when
// replay picks up a staged prompt so the provenance is recoverable.
export async function produceDraft(
  mode: PromptMode = "live",
  retro?: RetroOptions,
): Promise<DraftProduction | null> {
  // Step 0: config + prompts + the composer/editor stage instances.
  const run = await setupComposeRun(mode);

  // Step 1: gate pool — gate-passing, unpublished, in-window stories,
  // grouped into the theme-first editor pool. Null = nothing to compose.
  const gate = await loadGatePool(run.cfg);
  if (gate === null) return null;
  const { poolThemeMeta, cutoff, clusterByTheme } = gate;
  let pool = gate.pool;

  // Step 1b (catch-up runs only): append a bounded set of older,
  // durably-significant stories. Appended AFTER theme-first selection
  // rather than fed through it — selectEditorPool ranks on composite,
  // which is the axis catch-up items are deliberately not judged on.
  // The editor still sees them as one pool and may cut them all.
  if (retro !== undefined) {
    const retroRows = await loadRetroRows(retro);
    if (retroRows.length > 0) {
      // Clustered against the fresh pool's map rather than re-clustered:
      // the fresh pool's keys already drove selection, and recomputing
      // now could rename a cluster the selection was made under. A retro
      // item on a theme the fresh week doesn't touch gets no key and is
      // treated as its own cluster, which for a bounded handful of
      // catch-up items is the right conservative answer.
      stampClusterKeys(retroRows, clusterByTheme);
      const already = new Set(pool.map((p) => Number(p.row.story_id)));
      const retroEntries: EditorPoolEntry[] = retroRows
        .filter((r) => !already.has(Number(r.story_id)))
        .map((row) => {
          // Same source-count derivation selectEditorPool applies to
          // fresh rows — the editor reads these as corroboration, so
          // they must mean the same thing for both halves of the pool.
          const urls = [
            ...(row.source_url ? [row.source_url] : []),
            ...(row.additional_source_urls ?? []),
          ];
          return {
            row,
            tier1: countTier1(urls),
            total: urls.length,
            catchUp: true,
          };
        });
      pool = [...pool, ...retroEntries];
      console.log(
        `[compose] pool ${gate.pool.length} fresh + ${retroEntries.length} catch-up = ${pool.length}`,
      );
    }
  }

  // Step 2: editor curation — pick 10-15 from the pool.
  const { output: editorResult, input: editorInput } = await curateViaEditor(
    run.editor,
    pool,
    poolThemeMeta,
    gate.clusters,
    clusterByTheme,
    run.cfg["compose.recent_coverage_issues"],
  );
  const rawPicks = editorResult.picks
    .map(normalizePick)
    .sort((a, b) => a.rank - b.rank);
  const byId = new Map(pool.map((p) => [Number(p.row.story_id), p.row]));

  // Step 2b: diversity caps. The editor prompt has asked for topic
  // balance since v0.1 and still shipped issues whose entire lead
  // section was one narrative; this is the structural backstop, applied
  // to the editor's output before partitioning. It SPREADS a dominant
  // narrative down the sections rather than cutting it — one item up
  // top and one in Worth knowing reads as a story the brief is
  // following; five up top reads as a brief with one subject. See
  // compose-diversity.ts.
  const clusterOfLead = (leadStoryId: number): string | null =>
    byId.get(leadStoryId)?.cluster_key ?? null;
  const diversity = diversifyPicks(rawPicks, clusterOfLead, {
    maxPicksPerCluster: run.cfg["compose.max_picks_per_cluster"],
    maxPerSectionPerCluster: run.cfg["compose.max_per_section_per_cluster"],
  });
  const normalizedPicks = diversity.picks;
  if (diversity.cuts.length > 0 || diversity.movedDown.length > 0) {
    console.log(
      `[compose] diversity: cut ${diversity.cuts.length} over-cluster pick(s)` +
        (diversity.cuts.length > 0
          ? ` [${diversity.cuts.map((c) => `${c.lead_story_id}→${c.cluster_key}`).join(" ")}]`
          : "") +
        `, spread ${diversity.movedDown.length} into a later section` +
        (diversity.movedDown.length > 0
          ? ` [${diversity.movedDown.join(" ")}]`
          : ""),
    );
  }
  // Over-cap placements are routine at one or two — two five-wide
  // sections need ten picks and the editor targets 10–15, so the second
  // section runs out of other-cluster material as a matter of course.
  // Only flag it when it's most of the issue, which is the shape that
  // actually means "this week was one story".
  if (diversity.overCap.length > normalizedPicks.length / 2) {
    console.log(
      `[compose] diversity: ${diversity.overCap.length}/${normalizedPicks.length} picks placed over the per-section cap — the week really is one narrative`,
    );
  }

  const catchUpIds = new Set(
    pool.filter((p) => p.catchUp === true).map((p) => Number(p.row.story_id)),
  );
  const builtItems = buildComposerItems(normalizedPicks, byId, catchUpIds);
  if (builtItems.length === 0) {
    console.log("[compose] editor returned no valid picks — aborting");
    return null;
  }

  // Step 3: four-section partition (rank-based + safety override).
  const sections = await partitionBuiltItems(builtItems, byId);

  // Step 4: assemble the composer input (timelines, synthesis, shrug),
  // run the composer, and collect the published-set story ids.
  const input = await buildComposerInput(
    sections,
    byId,
    cutoff,
    run.cfg["compose.recent_coverage_issues"],
  );

  const arcCount = builtItems.filter((b) => b.item.kind === "arc").length;
  const deepArcs = input.theme_timelines.filter(
    (t) => t.n_prior_publications >= 2,
  ).length;
  console.log(
    `[compose] composing conv=${input.conversation.length} know=${input.worth_knowing.length} watch=${input.worth_watching.length} shrug=${input.shrug.length} arcs=${arcCount} themes=${input.theme_timelines.length} (${deepArcs} with 2+ prior issues)`,
  );
  const output = await run.composer.run(input);

  // Collect every story_id that appears in ANY section (including shrug)
  // — that's what gets persisted on the issue and flipped to
  // published_to_reader. Marking shrug items as published too prevents
  // them from recurring in the next week's shrug pool.
  const mainStoryIds = Array.from(
    new Set(
      [input.conversation, input.worth_knowing, input.worth_watching]
        .flat()
        .flatMap((it) => it.stories.map((s) => s.story_id)),
    ),
  );
  const shrugStoryIds = input.shrug.map((s) => s.story_id);
  const storyIds = Array.from(new Set([...mainStoryIds, ...shrugStoryIds]));

  return {
    output,
    storyIds,
    cfg: {
      ...run.cfg,
      "composer.prompt_version": run.composerVersion,
      "editor.prompt_version": run.editorVersion,
    },
    editorInput,
    editorResult,
    shrug: input.shrug,
    composerInput: input,
  };
}

// The pool SELECT shape. Shared verbatim by the gate pool, the catch-up
// pool, and the rowsForEditor type helper — PoolRow is derived from it,
// so a column added here reaches all three and none of them can drift
// into a different row shape.
const POOL_COLUMNS = [
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
  "story.payload_key",
] as const;

// One row of the gate-pool query. The pool query and rowsForEditor share
// an identical SELECT shape, so they share this type.
type PoolQueryRow = Awaited<ReturnType<typeof rowsForEditor>>[number];
// Plus one derived column that isn't in the SELECT: the row's narrative
// cluster, stamped by stampClusterKeys after the query. Optional so the
// query result assigns straight to PoolRow[].
type PoolRow = PoolQueryRow & { cluster_key?: string | null };
type EditorPoolEntry = {
  row: PoolRow;
  tier1: number;
  total: number;
  // Catch-up item (see RetroOptions). Drives the editor-input flag so
  // the prompt can judge it on durability rather than stale zeitgeist.
  catchUp?: boolean;
};
// A materialized pick: the ComposerItem plus the pool rows it came from
// (kept for partition routing and theme bookkeeping).
interface BuiltItem {
  item: ComposerItem;
  constituentRows: PoolRow[];
}
interface ComposeSections {
  conversation: ComposerItem[];
  worth_knowing: ComposerItem[];
  worth_watching: ComposerItem[];
}

interface ComposeRun {
  cfg: ConfigMap;
  composer: ReturnType<typeof makeComposer>;
  editor: ReturnType<typeof makeEditor>;
  composerVersion: string;
  editorVersion: string;
}

// Step 0: load config + prompts and build the composer/editor instances.
// mode='live' reads docs/*-prompt.md; mode='replay' checks prompt_draft
// first, tagging the version with "-staged" so provenance is recoverable.
async function setupComposeRun(mode: PromptMode): Promise<ComposeRun> {
  const cfg = await loadConfig();
  const composerPrompt = await loadSystemPromptText(
    "composer",
    COMPOSER_PROMPT_PATH,
    mode,
  );
  const editorPrompt = await loadSystemPromptText(
    "editor",
    EDITOR_PROMPT_PATH,
    mode,
  );
  const composerVersion =
    composerPrompt.source === "staged"
      ? `${cfg["composer.prompt_version"]}-staged`
      : cfg["composer.prompt_version"];
  const editorVersion =
    editorPrompt.source === "staged"
      ? `${cfg["editor.prompt_version"]}-staged`
      : cfg["editor.prompt_version"];
  const composer = makeComposer({
    version: composerVersion,
    modelId: cfg["composer.model_id"],
    promptPath: COMPOSER_PROMPT_PATH,
    maxTokens: cfg["composer.max_tokens"],
    systemPromptText: composerPrompt.text,
  });
  const editor = makeEditor({
    version: editorVersion,
    modelId: cfg["editor.model_id"],
    promptPath: EDITOR_PROMPT_PATH,
    maxTokens: cfg["editor.max_tokens"],
    systemPromptText: editorPrompt.text,
  });
  return { cfg, composer, editor, composerVersion, editorVersion };
}

// Step 1: query gate-passing, unpublished, in-window stories and group
// them into the theme-first editor pool. Returns null (and logs) when no
// stories qualify. Also returns the freshness cutoff so the shrug pool
// downstream uses the same window.
async function loadGatePool(cfg: ConfigMap): Promise<{
  pool: EditorPoolEntry[];
  poolThemeMeta: Map<number, ThemeMeta>;
  clusterByTheme: Map<number, string>;
  clusters: Awaited<ReturnType<typeof loadThemeClusters>>["clusters"];
  cutoff: Date;
} | null> {
  const cutoff = new Date(Date.now() - COMPOSE_STORY_MAX_AGE_MS);
  const rows: PoolRow[] = await db
    .selectFrom("story")
    .leftJoin("theme", "theme.id", "story.theme_id")
    .leftJoin("category", "category.id", "story.category_id")
    .select(POOL_COLUMNS)
    .where("story.passed_gate", "=", true)
    .where("story.published_to_reader", "=", false)
    .where("story.ingested_at", ">=", cutoff)
    .where((eb) =>
      eb.or([
        eb("story.published_at", "is", null),
        eb("story.published_at", ">=", cutoff),
      ]),
    )
    // Wikipedia entries are editorial-curation signal, not journalism
    // we'd write about. They still ride the ingest/score/theme path so
    // their theme attachment lights up wikipedia_corroborated below;
    // they just don't compete as picks in the editor pool.
    .where("story.source_name", "!=", "wikipedia")
    .orderBy("story.composite", "desc")
    .execute();

  if (rows.length === 0) {
    console.log("[compose] no passing, unpublished stories — skipping");
    return null;
  }

  // Resolve any cold-stored raw_output (mig 058) before the pool is
  // built; downstream readers see inline jsonb either way.
  await hydrateRawOutput(rows);

  // Narrative clustering runs BEFORE selection, because the cap it feeds
  // is a selection cap: by the time the editor sees a pool with five
  // themes off one story, the crowding is already baked in.
  const clusterLoad = await loadThemeClusters(
    rows
      .map((r) => (r.theme_id !== null ? Number(r.theme_id) : null))
      .filter((id): id is number => id !== null),
    cfg["editor.cluster_threshold"],
  );
  stampClusterKeys(rows, clusterLoad.byTheme);
  if (clusterLoad.multiThemeClusters.length > 0) {
    console.log(
      `[compose] narrative clusters (≥${cfg["editor.cluster_threshold"]} cosine): ` +
        clusterLoad.multiThemeClusters
          .map((c) => `${c.cluster_key}=[${c.theme_ids.join(",")}]`)
          .join(" "),
    );
  }

  // Theme-first pool selection (see src/shared/editor-pool.ts). Picks
  // top themes by max-composite + tier1, includes every gate-passing
  // member of each selected theme, fills until pool_size. Shared with
  // /admin/explore/editor sandbox so tuning is visible in both places.
  const poolResult = selectEditorPool(rows, cfg["editor.pool_max_themes"], {
    maxCategoryFraction: cfg["editor.pool_max_category_fraction"],
    maxClusterFraction: cfg["editor.pool_max_cluster_fraction"],
    maxStorySafetyCap: cfg["editor.pool_size"] * 4, // generous; primary cap is themes
  });
  const pool = poolResult.pool;
  const themesIncluded = poolResult.included
    .filter((b) => b.themeId !== null)
    .map((b) => b.themeId!);
  console.log(
    `[compose] ${poolResult.totalPassers} passers across ${poolResult.totalThemes} themes → editor pool of ${pool.length} stories from ${themesIncluded.length} themes (+ ${pool.length - themesIncluded.length} singletons)`,
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

  return {
    pool,
    poolThemeMeta,
    clusterByTheme: clusterLoad.byTheme,
    clusters: clusterLoad.clusters,
    cutoff,
  };
}

// Stamp the narrative cluster onto pool rows in place. Rows come
// straight out of the query, so this is the one place the derived
// column is attached — do it here and every consumer (pool selection,
// editor digest, post-editor caps) reads the same value.
function stampClusterKeys(
  rows: PoolRow[],
  byTheme: Map<number, string>,
): void {
  for (const r of rows) {
    r.cluster_key =
      r.theme_id !== null ? byTheme.get(Number(r.theme_id)) ?? null : null;
  }
}

// Catch-up pool: unpublished stories BETWEEN the retro window and the
// normal freshness cutoff (i.e. too old for the main pool), ranked by
// durable significance. See the RetroOptions header for why this axis
// and why passed_gate is ignored.
//
// Returns [] when nothing qualifies — a catch-up run with no worthwhile
// backlog is just a normal run, not an error.
async function loadRetroRows(opts: RetroOptions): Promise<PoolRow[]> {
  const windowDays = await getConfigNumber(
    "compose.retro_window_days",
    DEFAULT_RETRO_WINDOW_DAYS,
  );
  const maxItems = Math.floor(
    await getConfigNumber("compose.retro_max_items", DEFAULT_RETRO_MAX_ITEMS),
  );
  const now = Date.now();
  const freshCutoff = new Date(now - COMPOSE_STORY_MAX_AGE_MS);
  const retroCutoff = new Date(now - windowDays * 24 * 3600_000);

  let q = db
    .selectFrom("story")
    .leftJoin("theme", "theme.id", "story.theme_id")
    .leftJoin("category", "category.id", "story.category_id")
    .select(POOL_COLUMNS)
    .where("story.published_to_reader", "=", false)
    .where("story.scored_at", "is not", null)
    .where("story.source_name", "!=", "wikipedia")
    // Older than the fresh window but inside the catch-up window. Same
    // published_at-with-ingested_at-fallback treatment as the main pool
    // so a re-ingested archive URL can't smuggle ancient material in.
    .where((eb) =>
      eb.or([
        eb.and([
          eb("story.published_at", "is not", null),
          eb("story.published_at", "<", freshCutoff),
          eb("story.published_at", ">=", retroCutoff),
        ]),
        eb.and([
          eb("story.published_at", "is", null),
          eb("story.ingested_at", "<", freshCutoff),
          eb("story.ingested_at", ">=", retroCutoff),
        ]),
      ]),
    );

  if (opts.storyIds !== undefined) {
    if (opts.storyIds.length === 0) return [];
    // Operator-chosen ids. Still window- and unpublished-filtered above,
    // so a stale console tab can't resurrect an already-published story.
    q = q.where("story.id", "in", opts.storyIds);
  }

  const rows = await q
    .orderBy(
      sql`coalesce(story.structural_importance, 0) * coalesce(story.half_life, 0)`,
      "desc",
    )
    .orderBy("story.composite", "desc")
    .limit(opts.storyIds !== undefined ? opts.storyIds.length : maxItems)
    .execute();

  if (rows.length === 0) {
    console.log("[compose] catch-up: nothing in the backlog window");
    return [];
  }
  await hydrateRawOutput(rows);
  console.log(
    `[compose] catch-up: ${rows.length} item(s) from the ${windowDays}-day backlog window (ranked on structural_importance × half_life, gate ignored)`,
  );
  return rows;
}

// Step 2 (cont.): materialize each normalized editor pick into a
// ComposerItem, with its constituent stories sorted chronologically.
// Picks whose ids can't be resolved from the pool are dropped; partial
// arcs degrade to what matched. Pure — no DB.
function buildComposerItems(
  normalizedPicks: ReturnType<typeof normalizePick>[],
  byId: Map<number, PoolRow>,
  // Story ids that came from the catch-up pool. Empty on a normal run,
  // so every story renders exactly as it did before v0.10.
  catchUpIds: ReadonlySet<number> = new Set(),
): BuiltItem[] {
  const builtItems: BuiltItem[] = [];
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
            catch_up: catchUpIds.has(Number(r.story_id)),
            age_days: ageDays(r.published_at),
          };
        }),
      },
    });
  }
  return builtItems;
}

// Step 3: partition built items into the four fixed sections (see
// compose-partition.ts for the routing invariant: rank-based with a
// low-confidence / weak-evidence safety override, NOT confidence-primary).
// The composer never moves items between sections — placement is decided
// here.
async function partitionBuiltItems(
  builtItems: BuiltItem[],
  byId: Map<number, PoolRow>,
): Promise<ComposeSections> {
  const allRows = builtItems.flatMap((b) => b.constituentRows);
  const leadIds = builtItems.map((b) => b.item.lead_story_id);
  const allFactors = await loadFactorsByStory(
    [...new Set([...leadIds, ...allRows.map((r) => Number(r.story_id))])],
  );

  const conversation: ComposerItem[] = [];
  const worth_knowing: ComposerItem[] = [];
  const worth_watching: ComposerItem[] = [];

  for (const b of builtItems) {
    const leadRow = byId.get(b.item.lead_story_id) ?? b.constituentRows[0]!;
    const section = routeSection({
      kind: b.item.kind,
      rank: b.item.rank,
      confidence: leadRow.point_in_time_confidence,
      penaltyFactors: allFactors.get(b.item.lead_story_id)?.penalty ?? [],
    });
    if (section === "conversation") conversation.push(b.item);
    else if (section === "worth_knowing") worth_knowing.push(b.item);
    else worth_watching.push(b.item);
  }
  return { conversation, worth_knowing, worth_watching };
}

// Step 4: assemble the full ComposerInput from the partitioned sections —
// per-theme cross-issue timelines, the synthesis-themes opener seed, and
// the shrug pool.
async function buildComposerInput(
  sections: ComposeSections,
  byId: Map<number, PoolRow>,
  cutoff: Date,
  recentIssues: number,
): Promise<ComposerInput> {
  const { conversation, worth_knowing, worth_watching } = sections;

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
  //
  // Grouped by narrative CLUSTER, not by theme. Three themes off one
  // running story used to yield three synthesis entries, so the opening
  // paragraph named the same news three ways before the brief had even
  // started — the same saturation the section caps fix, in the one
  // paragraph the reader always reads. One cluster, one entry; the
  // cluster's best-placed item speaks for it.
  const synthesisItems = [...conversation, ...worth_knowing];
  const synthesisByCluster = new Map<
    string,
    {
      theme_id: number;
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
    // Unclustered themes key on themselves, so an unmeasured theme is
    // never folded into someone else's entry.
    const key = leadRow?.cluster_key ?? `t${tid}`;
    const existing = synthesisByCluster.get(key);
    const theme_name =
      leadRow?.theme_name ?? it.stories[0]?.theme_name ?? `theme #${tid}`;
    const category = it.stories[0]?.category ?? null;
    const shape =
      it.reason.length > 0
        ? it.reason
        : it.stories[0]?.scorer_one_liner ?? theme_name;
    // First writer wins (items arrive in section then rank order, so
    // that's the cluster's best-placed item), except that an arc
    // displaces a single — an arc's framing describes the thread.
    if (existing === undefined || (it.kind === "arc" && !existing.is_arc)) {
      synthesisByCluster.set(key, {
        theme_id: tid,
        theme_name,
        category,
        shape,
        is_arc: it.kind === "arc",
      });
    }
  }
  const synthesis_themes: ComposerInput["synthesis_themes"] =
    synthesisByCluster.size >= 2
      ? [...synthesisByCluster.values()].map((entry) => {
          const meta = themeMeta.get(entry.theme_id);
          return {
            theme_name: entry.theme_name,
            category: entry.category as ComposerInput["synthesis_themes"][number]["category"],
            shape: entry.shape,
            is_arc: entry.is_arc,
            trajectory: meta?.trajectory ?? "new",
          };
        })
      : [];

  const coverage = await loadRecentCoverage(recentIssues);
  const recent_issues: ComposerInput["recent_issues"] = coverage.issues.map(
    (issue) => ({
      published_at: issue.published_at,
      title: issue.title,
      weeks_ago: issue.weeks_ago,
      led_with: [
        ...new Set(
          issue.items
            .filter((i) => i.section === "conversation")
            .map((i) => i.theme_name)
            .filter((n): n is string => n !== null),
        ),
      ],
      already_told: issue.items.map((i) => i.summary),
    }),
  );

  return {
    week_of: new Date().toISOString().slice(0, 10),
    conversation,
    worth_knowing,
    worth_watching,
    shrug,
    theme_timelines,
    synthesis_themes,
    recent_issues,
  };
}

// Build an EditorInput from the ranked pool (tier-1 count pre-computed
// so we can surface it to the editor) and call the editor stage. Returns
// the editor's full output so compose can persist cuts_summary onto the
// issue for the admin review page.
// Whole days since publication. 0 for undated rows — the editor only
// reads this on catch-up items, which the pool query already bounded by
// date, so an unknown age there is better shown as 0 than guessed at.
function ageDays(publishedAt: Date | null): number {
  if (publishedAt === null) return 0;
  return Math.max(
    0,
    Math.floor((Date.now() - publishedAt.getTime()) / (24 * 3600_000)),
  );
}

async function curateViaEditor(
  editor: ReturnType<typeof makeEditor>,
  pool: EditorPoolEntry[],
  themeMeta: Map<number, ThemeMeta>,
  clusters: ThemeCluster[],
  clusterByTheme: Map<number, string>,
  recentIssues: number,
): Promise<{ output: EditorOutput; input: EditorInput }> {
  const storyIds = pool.map((p) => Number(p.row.story_id));
  const factorsByStory = await loadFactorsByStory(storyIds);
  const coverage = await loadRecentCoverage(recentIssues);

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
      catch_up: p.catchUp === true,
      age_days: ageDays(p.row.published_at),
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

  // Only clusters with a theme actually in the pool are worth rendering:
  // the cluster load covers every theme the gate query returned, and the
  // pool is a subset of that.
  const poolThemeIds = new Set(
    editorStories
      .map((s) => s.theme_id)
      .filter((id): id is number => id !== null),
  );
  const storiesPerTheme = new Map<number, number>();
  for (const s of editorStories) {
    if (s.theme_id === null) continue;
    storiesPerTheme.set(s.theme_id, (storiesPerTheme.get(s.theme_id) ?? 0) + 1);
  }
  const themeNames = new Map(
    editorStories
      .filter((s) => s.theme_id !== null && s.theme_name !== null)
      .map((s) => [s.theme_id!, s.theme_name!] as const),
  );
  const narrative_clusters: EditorInput["narrative_clusters"] = clusters
    .map((c) => {
      const inPool = c.theme_ids.filter((tid) => poolThemeIds.has(tid));
      return {
        cluster_key: c.cluster_key,
        theme_ids: inPool,
        theme_names: inPool.map((tid) => themeNames.get(tid) ?? `theme #${tid}`),
        n_stories: inPool.reduce(
          (sum, tid) => sum + (storiesPerTheme.get(tid) ?? 0),
          0,
        ),
      };
    })
    .filter((c) => c.theme_ids.length > 1);

  const input: EditorInput = {
    as_of_date: new Date().toISOString().slice(0, 10),
    pool_composition: buildPoolComposition(editorStories),
    stories: editorStories,
    themes: buildThemesDigest(
      pool,
      editorStories,
      themeMeta,
      clusterByTheme,
      coverage.byTheme,
    ),
    narrative_clusters,
    recent_coverage: coverage.issues,
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
  pool: EditorPoolEntry[],
  stories: EditorInput["stories"],
  themeMeta: Map<number, ThemeMeta>,
  clusterByTheme: Map<number, string>,
  coverageByTheme: Map<number, ThemeCoverage>,
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
    const coverage = coverageByTheme.get(theme_id);
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
      wikipedia_corroborated: meta?.wikipedia_corroborated ?? false,
      cluster_key: clusterByTheme.get(theme_id) ?? null,
      recent_issue_count: coverage?.issue_count ?? 0,
      last_covered_date: coverage?.last_covered_date ?? null,
      last_covered_summary: coverage?.last_covered_summary ?? null,
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
    .select(POOL_COLUMNS)
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
      "story.payload_key",
      "story_factor.factor as penalty_factor",
      "story.passed_gate",
      "story.scored_at",
    ])
    .where("story_factor.kind", "=", "penalty")
    .where("story_factor.factor", "in", [...SHRUG_PENALTY_FACTORS])
    .where("story.ingested_at", ">=", cutoff)
    .where((eb) =>
      eb.or([
        eb("story.published_at", "is", null),
        eb("story.published_at", ">=", cutoff),
      ]),
    )
    .where("story.scored_at", "is not", null)
    .where("story.passed_gate", "=", false)
    .where("story.published_to_reader", "=", false)
    .execute();

  await hydrateRawOutput(rows);

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
  // This 90-day window reaches well past the cold-tier offload age, so
  // read the denormalized scorer_summary column (always inline) rather
  // than raw_output — keeps compose from ever fetching a payload from
  // R2 for old published stories.
  const priorRows = await db
    .selectFrom("story")
    .select([
      "theme_id",
      "published_to_reader_at",
      "scorer_summary",
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
    list.push({
      date: r.published_to_reader_at?.toISOString().slice(0, 10) ?? "",
      one_liner: r.scorer_summary ?? "",
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
  // True when the theme has at least one Wikipedia member (ITN or
  // Current Events). Wikipedia stories never reach the editor pool;
  // this flag is the only path by which their signal informs picks.
  wikipedia_corroborated: boolean;
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
    .where("issue.is_draft", "=", false)
    .groupBy("story.theme_id")
    .execute();
  const priorCountMap = new Map<number, number>();
  for (const r of priorCounts) {
    if (r.theme_id === null) continue;
    priorCountMap.set(Number(r.theme_id), Number(r.n));
  }

  // Wikipedia membership: which of these themes have at least one story
  // ingested via the wikipedia connector? Distinct theme_id pass — flag
  // is boolean, no need to count. Reads any-age members so a long-
  // running theme stays "corroborated" once it ever was.
  const wikipediaCorroborated = new Set<number>();
  const wikiRows = await db
    .selectFrom("story")
    .select("theme_id")
    .distinct()
    .where("theme_id", "in", themeIds)
    .where("source_name", "=", "wikipedia")
    .execute();
  for (const r of wikiRows) {
    if (r.theme_id !== null) wikipediaCorroborated.add(Number(r.theme_id));
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
      wikipedia_corroborated: wikipediaCorroborated.has(tid),
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
  // Create as a draft. Stories stay published_to_reader=false until the
  // admin publishes; that lets the draft be re-composed/re-edited
  // without locking the pool. See src/pipeline/draft.ts for publish.
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
        is_draft: true,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const issueId = Number(issue.id);
    const pickRows = buildPickRows(issueId, composerInput);
    if (pickRows.length > 0) {
      await tx.insertInto("issue_pick").values(pickRows).execute();
    }

    return issueId;
  });
}

// Flatten composerInput sections into issue_pick rows. Arcs expand to
// one row per constituent story, all sharing the arc's section + rank
// (so release-on-re-edit catches every story).
export function buildPickRows(
  issueId: number,
  input: ComposerInput,
): Array<{ issue_id: number; story_id: number; section: string; rank: number }> {
  const rows: Array<{
    issue_id: number;
    story_id: number;
    section: string;
    rank: number;
  }> = [];
  const seen = new Set<number>();
  const push = (storyId: number, section: string, rank: number) => {
    if (seen.has(storyId)) return;
    seen.add(storyId);
    rows.push({ issue_id: issueId, story_id: storyId, section, rank });
  };
  for (const item of input.conversation) {
    for (const s of item.stories) push(s.story_id, "conversation", item.rank);
  }
  for (const item of input.worth_knowing) {
    for (const s of item.stories) push(s.story_id, "worth_knowing", item.rank);
  }
  for (const item of input.worth_watching) {
    for (const s of item.stories) push(s.story_id, "worth_watching", item.rank);
  }
  for (let i = 0; i < input.shrug.length; i++) {
    push(input.shrug[i]!.story_id, "shrug", i + 1);
  }
  return rows;
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
    "compose.min_publish_gap_hours",
  ] as const;
  for (const k of required) {
    if (map[k] === undefined) throw new Error(`missing config key: ${k}`);
  }
  // Soft cap added in migration 033. Default 1.0 (no cap) so a repo
  // without the migration still composes single-category pools.
  map["editor.pool_max_category_fraction"] ??= 1.0;
  // Theme-count primary cap, added in migration 034. Default 20.
  map["editor.pool_max_themes"] ??= 20;
  // Narrative clustering, added in migration 075. Defaults mirror the
  // migration so a repo that hasn't run it still composes — with the
  // caps active, since shipping the un-capped behaviour by default is
  // what the migration exists to stop.
  //
  // 0.72 sits deliberately between the story→theme attach bar (0.70)
  // and the theme→theme merge bar (0.85): tight enough that the pair is
  // one narrative, loose enough that we are not merely re-deriving the
  // merges reattach.ts already made.
  map["editor.cluster_threshold"] ??= 0.72;
  map["editor.pool_max_cluster_fraction"] ??= 0.25;
  map["compose.max_picks_per_cluster"] ??= 4;
  map["compose.max_per_section_per_cluster"] ??= 1;
  // Prior-issue memory, added in migration 075. Three issues is roughly
  // a month of a weekly — long enough to catch "we've led with this
  // three weeks running", short enough that the digest stays small.
  map["compose.recent_coverage_issues"] ??= 3;
  return map as ConfigMap;
}
