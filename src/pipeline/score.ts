// Pipeline stage: score.
// For each unscored, non-early-rejected story:
//   1. embed title+summary, store vector
//   2. theme-attach: NN search against theme centroids; Haiku-confirm if
//      similarity crosses threshold
//   3. call scorer with theme_context (if any)
//   4. persist raw_input, raw_output, denormalized scores, factors
//   5. if still no theme, create one seeded with this story's embedding
//   6. apply gate (absolute, relative, confidence) — set passed_gate

import { sql, type Selectable } from "kysely";

import { embed, embedBatch, toPgVector } from "../ai/embed.ts";
import { makeScorer } from "../ai/scorer.ts";
import { confirmThemeContinuation } from "../ai/theme-confirm.ts";
import { db } from "../db/index.ts";
import type { Database } from "../db/schema.ts";
import type {
  ScorerInput,
  ScorerOutput,
} from "../shared/scoring-schema.ts";

const ATTACH_SIMILARITY_THRESHOLD = 0.8;
// Re-check threshold inside the theme-create mutex. Higher than the
// regular attach threshold — we already decided (via LLM confirm) that
// nothing matched at 0.80; this is a last-moment check to catch neighbors
// that appeared while we were scoring.
const CREATE_RACE_RECHECK_THRESHOLD = 0.88;
const SCORING_CONCURRENCY = 4;

type ConfigMap = {
  "scorer.model_id": string;
  "scorer.prompt_version": string;
  "scorer.prompt_path": string;
  "scorer.max_tokens": number;
  "scorer.temperature": number;
  "gate.x_threshold": number;
  "gate.delta": number;
  "gate.confidence_floor": "low" | "medium" | "high";
};

export async function score(): Promise<void> {
  const cfg = await loadConfig();
  const scorer = makeScorer({
    version: cfg["scorer.prompt_version"],
    modelId: cfg["scorer.model_id"],
    promptPath: cfg["scorer.prompt_path"],
    maxTokens: cfg["scorer.max_tokens"],
    temperature: cfg["scorer.temperature"],
  });

  const stories = await db
    .selectFrom("story")
    .selectAll()
    .where("scored_at", "is", null)
    .where("early_reject", "=", false)
    .orderBy("ingested_at", "asc")
    .execute();

  console.log(`[score] ${stories.length} unscored stories`);
  await preEmbedStories(stories);

  const refreshed = await db
    .selectFrom("story")
    .selectAll()
    .where(
      "id",
      "in",
      stories.map((s) => s.id),
    )
    .execute();

  const total = refreshed.length;
  const runStart = Date.now();
  let done = 0;
  let ok = 0;
  let fail = 0;

  console.log(`[score] starting with concurrency=${SCORING_CONCURRENCY}`);

  await mapLimit(refreshed, SCORING_CONCURRENCY, async (story) => {
    const t0 = Date.now();
    try {
      const result = await processStory(story, scorer, cfg);
      ok++;
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const totalElapsed = ((Date.now() - runStart) / 1000).toFixed(0);
      const outcome = result.early_reject
        ? "early_reject"
        : `z=${result.zeitgeist_score} c=${result.composite} gate=${result.passed ? "PASS" : "fail"}`;
      done++;
      console.log(
        `[score] ${done}/${total} id=${story.id} ${outcome} (${elapsed}s, total ${totalElapsed}s)`,
      );
    } catch (err) {
      fail++;
      done++;
      console.error(`[score] ${done}/${total} id=${story.id} failed:`, err);
    }
  });
  console.log(`[score] done ok=${ok} fail=${fail}`);
}

type StoryRow = Selectable<Database["story"]>;

interface StoryResult {
  early_reject: boolean;
  zeitgeist_score: number;
  composite: number;
  passed: boolean;
}

async function processStory(
  story: StoryRow,
  scorer: ReturnType<typeof makeScorer>,
  cfg: ConfigMap,
): Promise<StoryResult> {
  const embeddingVec =
    story.embedding ?? (await ensureEmbedding(story));

  let themeId = story.theme_id;
  if (themeId === null) {
    themeId = await tryAttachToExistingTheme(story, embeddingVec);
  }

  const themeContext = themeId !== null ? await loadThemeContext(themeId) : null;
  const input = buildScorerInput(story, themeContext);
  const output = await scorer.run(input);

  await persistScorerResult(
    story.id,
    input,
    output,
    scorer.modelId,
    scorer.version,
  );

  let finalThemeId = themeId;
  if (finalThemeId === null && !output.classification.early_reject) {
    finalThemeId = await withThemeLock(async () => {
      // Race-guard: a concurrent worker may have just created a matching
      // theme while we were scoring. Cheap NN-only re-check with a
      // higher threshold — no LLM confirm since we already decided
      // nothing matched at attach time.
      const neighbor = await findMatchingThemeCheap(
        embeddingVec,
        CREATE_RACE_RECHECK_THRESHOLD,
      );
      if (neighbor !== null) {
        await db
          .updateTable("story")
          .set({ theme_id: neighbor.id, category_id: neighbor.category_id })
          .where("id", "=", story.id)
          .execute();
        return neighbor.id;
      }
      return await createThemeFromStory(story.id, embeddingVec, output);
    });
  }
  if (finalThemeId !== null) {
    await recomputeThemeRollingAvg(finalThemeId);
  }

  let passed = false;
  if (!output.classification.early_reject) {
    passed = await applyGate(story.id, cfg);
  }

  return {
    early_reject: output.classification.early_reject,
    zeitgeist_score: output.scores.zeitgeist,
    composite: output.scores.composite,
    passed,
  };
}

async function preEmbedStories(stories: StoryRow[]): Promise<void> {
  const needing = stories.filter((s) => s.embedding === null);
  if (needing.length === 0) return;

  console.log(`[score] embedding ${needing.length} stories (batched)`);
  const texts = needing.map((s) =>
    `${s.title}\n\n${s.summary ?? ""}`.trim(),
  );
  const vecs = await embedBatch(texts, "document");

  for (let i = 0; i < needing.length; i++) {
    const story = needing[i];
    const vec = vecs[i];
    if (!story || !vec) continue;
    await db
      .updateTable("story")
      .set({ embedding: toPgVector(vec) })
      .where("id", "=", story.id)
      .execute();
  }
}

async function ensureEmbedding(story: StoryRow): Promise<string> {
  const text = `${story.title}\n\n${story.summary ?? ""}`.trim();
  const vecs = await embed([text]);
  if (vecs.length === 0 || !vecs[0]) {
    throw new Error(`embed returned no vector for story ${story.id}`);
  }
  const pg = toPgVector(vecs[0]);
  await db
    .updateTable("story")
    .set({ embedding: pg })
    .where("id", "=", story.id)
    .execute();
  return pg;
}

async function tryAttachToExistingTheme(
  story: StoryRow,
  embeddingVec: string,
): Promise<number | null> {
  const row = await db
    .selectFrom("theme")
    .select([
      "id",
      "name",
      "description",
      "category_id",
      sql<number>`1 - (centroid_embedding <=> ${embeddingVec}::vector)`.as(
        "sim",
      ),
    ])
    .where("centroid_embedding", "is not", null)
    .orderBy(sql`centroid_embedding <=> ${embeddingVec}::vector`)
    .limit(1)
    .executeTakeFirst();

  if (!row || row.sim < ATTACH_SIMILARITY_THRESHOLD) return null;

  const recent = await db
    .selectFrom("story")
    .select(["raw_output"])
    .where("theme_id", "=", row.id)
    .where("scored_at", "is not", null)
    .orderBy("scored_at", "desc")
    .limit(3)
    .execute();

  const recentSummaries = recent
    .map((r) => readSummary(r.raw_output))
    .filter((s) => s.length > 0);

  const confirm = await confirmThemeContinuation({
    story_title: story.title,
    story_summary: story.summary,
    theme_name: row.name,
    theme_description: row.description,
    recent_summaries: recentSummaries,
    cosine_similarity: row.sim,
  });

  if (!confirm.is_continuation) return null;

  await db
    .updateTable("story")
    .set({ theme_id: row.id, category_id: row.category_id })
    .where("id", "=", story.id)
    .execute();
  return row.id;
}

async function loadThemeContext(
  themeId: number,
): Promise<ScorerInput["theme_context"]> {
  const theme = await db
    .selectFrom("theme")
    .select(["name", "description", "rolling_composite_avg"])
    .where("id", "=", themeId)
    .executeTakeFirst();
  if (!theme) return null;

  const recent = await db
    .selectFrom("story")
    .select([
      "scored_at",
      "zeitgeist_score",
      "raw_output",
    ])
    .where("theme_id", "=", themeId)
    .where("scored_at", "is not", null)
    .orderBy("scored_at", "desc")
    .limit(5)
    .execute();

  return {
    theme_name: theme.name,
    theme_description: theme.description ?? undefined,
    rolling_composite_avg:
      theme.rolling_composite_avg !== null
        ? Number(theme.rolling_composite_avg)
        : undefined,
    recent_stories: recent.map((r) => ({
      date: r.scored_at ? r.scored_at.toISOString().slice(0, 10) : "",
      zeitgeist: r.zeitgeist_score ?? undefined,
      one_line_summary: readSummary(r.raw_output),
    })),
  };
}

function buildScorerInput(
  story: StoryRow,
  themeContext: ScorerInput["theme_context"],
): ScorerInput {
  return {
    as_of_date: new Date().toISOString().slice(0, 10),
    story: {
      title: story.title,
      summary: story.summary ?? undefined,
      source_url: story.source_url ?? undefined,
      published_at: story.published_at?.toISOString(),
    },
    theme_context: themeContext,
  };
}

async function persistScorerResult(
  storyId: number,
  input: ScorerInput,
  output: ScorerOutput,
  modelId: string,
  promptVersion: string,
): Promise<void> {
  const categoryId = await lookupCategoryId(output.classification.category);

  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable("story")
      .set({
        scorer_model_id: modelId,
        scorer_prompt_version: promptVersion,
        raw_input: input as never,
        raw_output: output as never,
        category_id: categoryId,
        zeitgeist_score: output.scores.zeitgeist,
        half_life: output.scores.half_life,
        reach: output.scores.reach,
        non_obviousness: output.scores.non_obviousness,
        structural_importance: output.scores.structural_importance,
        composite: String(output.scores.composite),
        point_in_time_confidence: output.reasoning.confidence,
        theme_relationship: output.reasoning.theme_relationship,
        base_rate_per_year: String(output.reasoning.base_rate_per_year),
        scored_at: new Date(),
        early_reject: output.classification.early_reject,
      })
      .where("id", "=", storyId)
      .execute();

    await tx
      .deleteFrom("story_factor")
      .where("story_id", "=", storyId)
      .execute();

    const rows: Array<{
      story_id: number;
      kind: "trigger" | "penalty" | "uncertainty";
      factor: string;
    }> = [];
    for (const f of output.reasoning.factors.trigger)
      rows.push({ story_id: storyId, kind: "trigger", factor: f });
    for (const f of output.reasoning.factors.penalty)
      rows.push({ story_id: storyId, kind: "penalty", factor: f });
    for (const f of output.reasoning.factors.uncertainty)
      rows.push({ story_id: storyId, kind: "uncertainty", factor: f });
    if (rows.length > 0) {
      await tx.insertInto("story_factor").values(rows).execute();
    }
  });
}

async function createThemeFromStory(
  storyId: number,
  embeddingVec: string,
  output: ScorerOutput,
): Promise<number | null> {
  const categoryId = await lookupCategoryId(output.classification.category);
  // theme.category_id is NOT NULL — skip theme creation when scorer gave
  // no valid category. Story stays theme-less; it's still scored.
  if (categoryId === null) return null;

  const row = await db
    .insertInto("theme")
    .values({
      category_id: categoryId,
      name: output.summary.slice(0, 200),
      description: null,
      centroid_embedding: embeddingVec,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  await db
    .updateTable("story")
    .set({ theme_id: row.id })
    .where("id", "=", storyId)
    .execute();

  return row.id;
}

async function recomputeThemeRollingAvg(themeId: number): Promise<void> {
  await db
    .updateTable("theme")
    .set({
      rolling_composite_avg: sql`(
        SELECT avg(composite)::numeric
        FROM story
        WHERE theme_id = ${themeId} AND composite IS NOT NULL
      )`,
      last_published_at: sql`(
        SELECT max(scored_at)
        FROM story
        WHERE theme_id = ${themeId} AND scored_at IS NOT NULL
      )`,
    })
    .where("id", "=", themeId)
    .execute();
}

async function applyGate(storyId: number, cfg: ConfigMap): Promise<boolean> {
  const story = await db
    .selectFrom("story")
    .select([
      "composite",
      "point_in_time_confidence",
      "theme_id",
    ])
    .where("id", "=", storyId)
    .executeTakeFirst();
  if (!story || story.composite === null) return false;

  const composite = Number(story.composite);
  // Relative gate must compare against PRIOR stories in the theme, not
  // the rolling average that already includes this story. For a brand-new
  // single-story theme, there is no prior average — treat as 0.
  let themeAvg = 0;
  if (story.theme_id !== null) {
    const prior = await db
      .selectFrom("story")
      .select(({ fn }) => fn.avg<string | null>("composite").as("avg"))
      .where("theme_id", "=", story.theme_id)
      .where("id", "!=", storyId)
      .where("composite", "is not", null)
      .executeTakeFirst();
    if (prior?.avg !== null && prior?.avg !== undefined) {
      themeAvg = Number(prior.avg);
    }
  }

  const passAbsolute = composite >= cfg["gate.x_threshold"];
  const passRelative = composite > themeAvg + cfg["gate.delta"];
  const passConfidence = confidenceAtLeast(
    story.point_in_time_confidence as "low" | "medium" | "high" | null,
    cfg["gate.confidence_floor"],
  );
  const passed = passAbsolute && passRelative && passConfidence;

  await db
    .updateTable("story")
    .set({ passed_gate: passed })
    .where("id", "=", storyId)
    .execute();
  return passed;
}

// Bounded-concurrency runner. Each worker pulls the next index and runs
// fn; errors are swallowed here (caller logs them) so one failure does
// not abort the batch.
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) continue;
      await fn(item, i);
    }
  };
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, worker));
}

// Serializes theme-create operations to prevent parallel workers from
// creating duplicate themes for stories that should share one. The
// scoring call itself is not serialized — only the brief create/recheck
// moment. .catch swallows prev errors so the chain survives individual
// failures.
let themeSerializer: Promise<unknown> = Promise.resolve();
function withThemeLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = themeSerializer.then(fn, fn);
  themeSerializer = run.catch(() => undefined);
  return run;
}

// NN-only theme lookup without LLM confirmation. Used inside the theme
// lock to catch very-recent neighbors without adding Haiku calls.
async function findMatchingThemeCheap(
  embeddingVec: string,
  threshold: number,
): Promise<{ id: number; category_id: number } | null> {
  const row = await db
    .selectFrom("theme")
    .select([
      "id",
      "category_id",
      sql<number>`1 - (centroid_embedding <=> ${embeddingVec}::vector)`.as(
        "sim",
      ),
    ])
    .where("centroid_embedding", "is not", null)
    .orderBy(sql`centroid_embedding <=> ${embeddingVec}::vector`)
    .limit(1)
    .executeTakeFirst();
  if (!row || row.sim < threshold) return null;
  return { id: row.id, category_id: row.category_id };
}

// Read a story's one-line summary from its raw_output jsonb. Old rows
// (v0.1 prompt) stored `one_line_summary`; newer rows store `summary`.
function readSummary(rawOutput: unknown): string {
  const r = rawOutput as {
    summary?: string;
    one_line_summary?: string;
  } | null;
  return r?.summary ?? r?.one_line_summary ?? "";
}

function confidenceAtLeast(
  actual: "low" | "medium" | "high" | null,
  floor: "low" | "medium" | "high",
): boolean {
  const order = { low: 0, medium: 1, high: 2 };
  if (actual === null) return false;
  return order[actual] >= order[floor];
}

async function lookupCategoryId(slug: string | null): Promise<number | null> {
  if (slug === null) return null;
  const row = await db
    .selectFrom("category")
    .select("id")
    .where("slug", "=", slug)
    .executeTakeFirst();
  return row?.id ?? null;
}

async function loadConfig(): Promise<ConfigMap> {
  const rows = await db
    .selectFrom("config")
    .select(["key", "value"])
    .execute();
  const map: Record<string, unknown> = {};
  for (const r of rows) map[r.key] = r.value;

  const required = [
    "scorer.model_id",
    "scorer.prompt_version",
    "scorer.prompt_path",
    "scorer.max_tokens",
    "scorer.temperature",
    "gate.x_threshold",
    "gate.delta",
    "gate.confidence_floor",
  ] as const;
  for (const k of required) {
    if (map[k] === undefined) throw new Error(`missing config key: ${k}`);
  }
  return map as ConfigMap;
}
