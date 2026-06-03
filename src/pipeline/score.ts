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

import { BudgetExceededError } from "../ai/budget.ts";
import { embed, embedBatch, toPgVector } from "../ai/embed.ts";
import { recomputeThemeCentroid } from "../shared/embedding-utils.ts";
import { makeScorer } from "../ai/scorer.ts";
import { confirmThemeContinuation } from "../ai/theme-confirm.ts";
import { notifyAdmin, renderAdminNotice } from "../shared/admin-notify.ts";
import { db } from "../db/index.ts";
import type { Database } from "../db/schema.ts";
import {
  describeOffPeakWindow,
  isWithinDeepSeekOffPeak,
  minutesUntilOffPeakStart,
} from "../shared/off-peak.ts";
import { isLockHeld, withLock } from "../shared/pipeline-lock.ts";
import { reportProgress } from "../shared/pipeline-status.ts";
import type {
  ScorerInput,
  ScorerOutput,
} from "../shared/scoring-schema.ts";

// Theme-attach thresholds live in the config table now (see
// migrations/030_theme_attach_config.sql). Tunable on /admin/config
// without a redeploy or a re-score.
const SCORING_CONCURRENCY = 4;

type ConfigMap = {
  "scorer.client": "anthropic" | "openai_compat";
  "scorer.off_peak_only": boolean;
  "scorer.model_id": string;
  "scorer.prompt_version": string;
  "scorer.prompt_path": string;
  "scorer.max_tokens": number;
  "scorer.temperature": number;
  "scorer.prefilter_model_id": string | null;
  "scorer.prefilter_prompt_version": string;
  "scorer.prefilter_top_fraction": number;
  "scorer.prefilter_max_tokens": number;
  "scorer.dedup_enabled": boolean;
  "scorer.dedup_similarity_threshold": number;
  "scorer.dedup_lookback_days": number;
  "gate.x_threshold": number;
  "gate.delta": number;
  "gate.confidence_floor": "low" | "medium" | "high";
  "theme.attach_threshold": number;
  "theme.create_recheck_threshold": number;
};

export async function score(): Promise<void> {
  if (await isLockHeld("ingest")) {
    console.log("[score] ingest is still running, skipping");
    return;
  }
  await withLock("score", 60 * 60_000, runScore);
}

// Classifies errors that won't fix themselves within the batch —
// running the remaining 1299 stories after the first one fails for the
// same reason just burns time (and on free tiers, retry quotas). The
// scorer aborts and notifies the admin so the operator can intervene.
//
// Covers Anthropic / Voyage / Resend phrasing (Anthropic surfaces
// insufficient-credit as 4xx with "credit_balance_too_low" or similar)
// AND OpenAI-compatible HTTP status codes (401 auth, 402 billing,
// 403 forbidden/TOS, 404 model-not-found). DeepSeek's "Insufficient
// Balance" body is matched via the "balance" keyword.
//
// 429 (rate limit) and 5xx are intentionally NOT classified as
// permanent — they're transient and the next scheduler tick should
// retry.
type PermanentErrorReason =
  | "daily budget cap exceeded"
  | "provider account out of funds"
  | "provider auth failed (check API key)"
  | "provider forbidden (check TOS / region / quota)"
  | "model not found (check scorer.model_id)";

function classifyPermanentError(err: unknown): PermanentErrorReason | null {
  if (err instanceof BudgetExceededError) return "daily budget cap exceeded";
  const msg = err instanceof Error ? err.message : String(err);

  // Billing / payment / credit-exhaustion phrases, across providers.
  if (
    /\b(insufficient[_\s-]?(credit|funds|quota|balance)|credit_balance_too_low|billing|payment[_\s-]?required|quota[_\s-]?exceeded|out[_\s-]?of[_\s-]?credit)\b/i.test(
      msg,
    )
  ) {
    return "provider account out of funds";
  }

  // OpenAI-compat HTTP status codes (formatted in openai-client.ts as
  // "openai-compat 4XX <statusText>: ..."). Anthropic SDK errors don't
  // follow this format; their phrasing is caught by the regex above.
  const httpMatch = /openai-compat (\d{3})\b/i.exec(msg);
  if (httpMatch) {
    const code = httpMatch[1];
    if (code === "401") return "provider auth failed (check API key)";
    if (code === "402") return "provider account out of funds";
    if (code === "403") return "provider forbidden (check TOS / region / quota)";
    if (code === "404") return "model not found (check scorer.model_id)";
  }
  return null;
}

async function notifyScorerHalted(
  reason: PermanentErrorReason,
  err: unknown,
): Promise<void> {
  const detail = err instanceof Error ? err.message : String(err);
  const notice = renderAdminNotice({
    heading: `Scorer halted — ${reason}`,
    bodyLines: [
      `The scoring pipeline aborted because: ${reason}.`,
      `Underlying error: ${detail}`,
      `Fix the underlying issue (top up the provider, rotate the key, correct the model id, or raise budget.daily_usd_cap) and the next scheduled tick will resume.`,
    ],
  });
  await notifyAdmin({
    subject: `[blurpadurp] Scorer halted — ${reason}`,
    html: notice.html,
    text: notice.text,
    dedupeKey: `scorer-halted-${reason.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
    cooldownMs: 6 * 3600_000,
  });
}

async function runScore(): Promise<void> {
  const cfg = await loadConfig();

  // Off-peak guard. When enabled, scoring only runs during DeepSeek's
  // 50%-discount window. The scheduler will retry on its next tick;
  // with hourly ticks the run self-corrects into the window within an
  // hour of when it becomes due. Skipping here is cheaper than running
  // at full price, and the existing dedup/embedding inheritance means
  // a one-day delay on some stories costs nothing.
  if (cfg["scorer.off_peak_only"] && !isWithinDeepSeekOffPeak()) {
    const mins = minutesUntilOffPeakStart();
    console.log(
      `[score] off_peak_only=true, outside ${describeOffPeakWindow()} (in ~${mins}m). Skipping.`,
    );
    return;
  }

  const scorer = makeScorer({
    client: cfg["scorer.client"],
    version: cfg["scorer.prompt_version"],
    modelId: cfg["scorer.model_id"],
    promptPath: cfg["scorer.prompt_path"],
    maxTokens: cfg["scorer.max_tokens"],
    temperature: cfg["scorer.temperature"],
  });

  const prefilterCandidates = await db
    .selectFrom("story")
    .selectAll()
    .where("scored_at", "is", null)
    .where("early_reject", "=", false)
    .orderBy("ingested_at", "asc")
    .execute();

  // Progressive scoring phase A: cheap-model prefilter on everything that
  // hasn't been looked at yet. Populates first_pass_* columns but does
  // not touch theme attach, embeddings, or the main scored fields.
  const prefilterModel = cfg["scorer.prefilter_model_id"];
  if (prefilterModel !== null) {
    const needsPrefilter = prefilterCandidates.filter(
      (s) => s.first_pass_scored_at === null,
    );
    if (needsPrefilter.length > 0) {
      await runPrefilterPass(needsPrefilter, cfg);
    }
  }

  // Select the cohort for the full (expensive) pass. When prefilter is
  // active, that's the top-fraction by first_pass_composite. When it's
  // disabled, we fall back to everything unscored + non-rejected.
  const stories =
    prefilterModel === null
      ? prefilterCandidates
      : selectTopByPrefilter(
          prefilterCandidates,
          cfg["scorer.prefilter_top_fraction"],
        );

  console.log(
    `[score] ${stories.length} stories for full scoring` +
      (prefilterModel !== null
        ? ` (prefilter picked top ${Math.round(cfg["scorer.prefilter_top_fraction"] * 100)}% of ${prefilterCandidates.length})`
        : ""),
  );
  await preEmbedStories(stories);

  const refreshed =
    stories.length === 0
      ? []
      : await db
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
  await reportProgress("score", 0, total, true);

  const abort: AbortFlag = { stopped: false, reason: null };
  let aborted = 0;

  await mapLimit(refreshed, SCORING_CONCURRENCY, async (story) => {
    if (abort.stopped) {
      aborted++;
      return;
    }
    const t0 = Date.now();
    try {
      const result = await processStory(story, scorer, cfg);
      ok++;
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const totalElapsed = ((Date.now() - runStart) / 1000).toFixed(0);
      const inheritTag =
        result.inherited_from !== null
          ? ` [inherit←#${result.inherited_from} sim=${result.inherited_similarity?.toFixed(3)}]`
          : "";
      const outcome = result.early_reject
        ? `early_reject${inheritTag}`
        : `z=${result.zeitgeist_score} c=${result.composite} gate=${result.passed ? "PASS" : "fail"}${inheritTag}`;
      done++;
      console.log(
        `[score] ${done}/${total} id=${story.id} ${outcome} (${elapsed}s, total ${totalElapsed}s)`,
      );
      await reportProgress("score", done, total);
    } catch (err) {
      const fatalReason = classifyPermanentError(err);
      if (fatalReason !== null) {
        abort.stopped = true;
        abort.reason = fatalReason;
        fail++;
        done++;
        console.error(
          `[score] ${done}/${total} id=${story.id} ${fatalReason} — aborting batch:`,
          err,
        );
        await notifyScorerHalted(fatalReason, err);
        await reportProgress("score", done, total, true);
        return;
      }
      fail++;
      done++;
      console.error(`[score] ${done}/${total} id=${story.id} failed:`, err);
      await reportProgress("score", done, total);
    }
  });
  await reportProgress("score", done, total, true);
  if (abort.stopped) {
    console.log(
      `[score] aborted: ${abort.reason}. ok=${ok} fail=${fail} skipped=${aborted}`,
    );
  } else {
    console.log(`[score] done ok=${ok} fail=${fail}`);
  }
}

interface AbortFlag {
  stopped: boolean;
  reason: PermanentErrorReason | null;
}

// Progressive scoring phase A. Runs every unscored story through the
// cheap prefilter model. Skips theme_context / embeddings — prefilter
// scores on title + summary alone. Writes only first_pass_* columns.
async function runPrefilterPass(
  stories: Array<Selectable<Database["story"]>>,
  cfg: ConfigMap,
): Promise<void> {
  const modelId = cfg["scorer.prefilter_model_id"];
  if (modelId === null) return;
  const scorer = makeScorer({
    client: cfg["scorer.client"],
    version: cfg["scorer.prefilter_prompt_version"],
    modelId,
    promptPath: cfg["scorer.prompt_path"],
    maxTokens: cfg["scorer.prefilter_max_tokens"],
    temperature: 0,
  });

  console.log(
    `[score] prefilter: ${stories.length} stories with ${modelId}`,
  );
  let done = 0;
  const abort: AbortFlag = { stopped: false, reason: null };
  await mapLimit(stories, SCORING_CONCURRENCY, async (story) => {
    if (abort.stopped) return;
    try {
      // Prefilter pass: no theme context (embeddings + attach happen in
      // the final pass). Scorer input's theme_context is nullable.
      const input: ScorerInput = buildScorerInput(story, null);
      const output = await scorer.run(input);
      await db
        .updateTable("story")
        .set({
          first_pass_composite: String(output.scores.composite),
          first_pass_model_id: modelId,
          first_pass_prompt_version: cfg["scorer.prefilter_prompt_version"],
          first_pass_scored_at: new Date(),
          // Early-reject from prefilter should still flag the row so the
          // final pass skips it — saves a full-model call on obvious junk.
          early_reject: output.classification.early_reject
            ? true
            : (story.early_reject as unknown as boolean),
        })
        .where("id", "=", story.id)
        .execute();
      done++;
      if (done % 20 === 0) {
        console.log(`[score] prefilter ${done}/${stories.length}`);
      }
    } catch (err) {
      const fatalReason = classifyPermanentError(err);
      if (fatalReason !== null) {
        abort.stopped = true;
        abort.reason = fatalReason;
        console.error(
          `[score] prefilter id=${story.id} ${fatalReason} — aborting:`,
          err,
        );
        await notifyScorerHalted(fatalReason, err);
        return;
      }
      done++;
      console.error(
        `[score] prefilter id=${story.id} failed:`,
        err,
      );
    }
  });
  if (abort.stopped) {
    console.log(`[score] prefilter aborted: ${abort.reason}`);
    throw new Error(`prefilter aborted: ${abort.reason}`);
  }
  console.log(`[score] prefilter done`);
}

// Given the full candidate pool with (possibly) populated first_pass_composite,
// return the top-fraction by prefilter composite. Stories without a
// prefilter score (shouldn't happen in practice but defensive) rank last.
function selectTopByPrefilter<
  T extends { id: number; first_pass_composite: string | null; early_reject: boolean },
>(all: T[], topFraction: number): T[] {
  const eligible = all.filter((s) => !s.early_reject);
  if (eligible.length === 0) return [];
  const sorted = [...eligible].sort((a, b) => {
    const ca =
      a.first_pass_composite !== null ? Number(a.first_pass_composite) : -1;
    const cb =
      b.first_pass_composite !== null ? Number(b.first_pass_composite) : -1;
    return cb - ca;
  });
  const cut = Math.max(1, Math.ceil(sorted.length * topFraction));
  return sorted.slice(0, cut);
}

type StoryRow = Selectable<Database["story"]>;

interface StoryResult {
  early_reject: boolean;
  zeitgeist_score: number;
  composite: number;
  passed: boolean;
  inherited_from: number | null;
  inherited_similarity: number | null;
}

async function processStory(
  story: StoryRow,
  scorer: ReturnType<typeof makeScorer>,
  cfg: ConfigMap,
): Promise<StoryResult> {
  const embeddingVec =
    story.embedding ?? (await ensureEmbedding(story));

  // Semantic dedup. Before paying for a full scorer call, check whether
  // a near-duplicate was scored recently. If similarity crosses the
  // threshold, inherit that neighbor's scores verbatim and skip the LLM.
  // Chains are prevented by excluding inherited rows from the search.
  if (cfg["scorer.dedup_enabled"]) {
    const inherit = await tryInheritFromNeighbor(
      story,
      embeddingVec,
      cfg["scorer.dedup_similarity_threshold"],
      cfg["scorer.dedup_lookback_days"],
    );
    if (inherit !== null) {
      // Inherited rows still run the gate (it's mechanical — no LLM)
      // so passed_gate reflects the current gate config, not whatever
      // was in force when the donor was scored.
      const passed = inherit.early_reject ? false : await applyGate(story.id, cfg);
      return {
        early_reject: inherit.early_reject,
        zeitgeist_score: inherit.zeitgeist_score,
        composite: inherit.composite,
        passed,
        inherited_from: inherit.neighborId,
        inherited_similarity: inherit.similarity,
      };
    }
  }

  let themeId = story.theme_id;
  if (themeId === null) {
    themeId = await tryAttachToExistingTheme(
      story,
      embeddingVec,
      cfg["theme.attach_threshold"],
    );
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
        cfg["theme.create_recheck_threshold"],
      );
      if (neighbor !== null) {
        await db
          .updateTable("story")
          .set({ theme_id: neighbor.id, category_id: neighbor.category_id })
          .where("id", "=", story.id)
          .execute();
        return neighbor.id;
      }
      return await createThemeFromStory(
        story.id,
        story.title,
        embeddingVec,
        output,
      );
    });
  }
  // Post-score embedding refinement. The original embedding was
  // computed from `title + raw_summary` (often title alone for GDELT
  // stories with null summary) — too thin a signal to cluster
  // same-event stories across outlets. The scorer's `summary` is much
  // richer: language-normalized, event-focused, consistent style. We
  // re-embed using `title + scorer_summary` and then recompute the
  // theme's centroid so subsequent attaches in this run see the
  // improved centroid. Skip on early-reject (summary may be sparse)
  // and on empty summary (defensive).
  if (
    !output.classification.early_reject &&
    output.summary.trim().length > 0
  ) {
    await refineEmbeddingPostScore(
      story.id,
      story.title,
      output.summary,
      finalThemeId,
    );
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
    inherited_from: null,
    inherited_similarity: null,
  };
}

// Semantic dedup lookup + inherit. Scans the `story` table for the
// nearest already-scored (and not-itself-inherited) row within the
// lookback window. If cosine similarity ≥ threshold, copies the donor's
// raw_output + denormalized scores + factors onto this row and sets
// scored_via_story_id. raw_input stays NULL — signals "we skipped the
// scorer" and lets replay audits differentiate.
async function tryInheritFromNeighbor(
  story: StoryRow,
  embeddingVec: string,
  threshold: number,
  lookbackDays: number,
): Promise<{
  neighborId: number;
  similarity: number;
  early_reject: boolean;
  zeitgeist_score: number;
  composite: number;
} | null> {
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 3600_000);
  const row = await db
    .selectFrom("story")
    .select([
      "id",
      "raw_output",
      "payload_key",
      "scorer_summary",
      "theme_id",
      "category_id",
      "zeitgeist_score",
      "half_life",
      "reach",
      "non_obviousness",
      "structural_importance",
      "composite",
      "point_in_time_confidence",
      "theme_relationship",
      "base_rate_per_year",
      "early_reject",
      "scorer_model_id",
      "scorer_prompt_version",
      sql<number>`1 - (embedding <=> ${embeddingVec}::halfvec)`.as("sim"),
    ])
    .where("scored_at", ">=", cutoff)
    .where("scored_via_story_id", "is", null)
    .where("id", "!=", story.id)
    .where("embedding", "is not", null)
    .orderBy(sql`embedding <=> ${embeddingVec}::halfvec`)
    .limit(1)
    .executeTakeFirst();

  if (!row || row.sim < threshold) return null;

  await db
    .updateTable("story")
    .set({
      scored_at: new Date(),
      scored_via_story_id: Number(row.id),
      scorer_model_id: row.scorer_model_id,
      scorer_prompt_version: row.scorer_prompt_version,
      // Inherit the donor's raw_output. If the donor's payload is
      // cold-stored, share its object key (identical content); else
      // copy the inline jsonb. raw_input stays NULL — the "we skipped
      // the scorer" marker (see function header).
      raw_output: row.payload_key !== null ? null : (row.raw_output as never),
      payload_key: row.payload_key,
      scorer_summary: row.scorer_summary,
      zeitgeist_score: row.zeitgeist_score,
      half_life: row.half_life,
      reach: row.reach,
      non_obviousness: row.non_obviousness,
      structural_importance: row.structural_importance,
      composite: row.composite,
      point_in_time_confidence: row.point_in_time_confidence,
      theme_relationship: row.theme_relationship,
      base_rate_per_year: row.base_rate_per_year,
      early_reject: row.early_reject,
      theme_id: row.theme_id,
      category_id: row.category_id,
    })
    .where("id", "=", story.id)
    .execute();

  // Copy the donor's factor tags onto this story. Duplicates are no-ops
  // via the primary key.
  const factors = await db
    .selectFrom("story_factor")
    .select(["kind", "factor"])
    .where("story_id", "=", Number(row.id))
    .execute();
  if (factors.length > 0) {
    await db
      .insertInto("story_factor")
      .values(
        factors.map((f) => ({
          story_id: story.id,
          kind: f.kind,
          factor: f.factor,
        })),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  return {
    neighborId: Number(row.id),
    similarity: row.sim,
    early_reject: row.early_reject,
    zeitgeist_score: row.zeitgeist_score ?? 0,
    composite: row.composite !== null ? Number(row.composite) : 0,
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

// Re-embed a scored story using `title + scorer_summary` and update
// its theme centroid. Called after persistScorerResult — the scorer
// summary is the highest-signal text we have for clustering. Failures
// are non-fatal (we don't want one Voyage hiccup to break the whole
// scoring run); the original embedding stays in place if this fails.
async function refineEmbeddingPostScore(
  storyId: number,
  title: string,
  scorerSummary: string,
  themeId: number | null,
): Promise<void> {
  try {
    const text = `${title}\n\n${scorerSummary}`.trim();
    const vecs = await embed([text]);
    const vec = vecs[0];
    if (!vec) return;
    await db
      .updateTable("story")
      .set({ embedding: toPgVector(vec) })
      .where("id", "=", storyId)
      .execute();
    if (themeId !== null) {
      await recomputeThemeCentroid(themeId);
    }
  } catch (err) {
    console.warn(
      `[score] post-score reembed failed for story ${storyId}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

async function tryAttachToExistingTheme(
  story: StoryRow,
  embeddingVec: string,
  threshold: number,
): Promise<number | null> {
  const row = await db
    .selectFrom("theme")
    .select([
      "id",
      "name",
      "description",
      "category_id",
      sql<number>`1 - (centroid_embedding <=> ${embeddingVec}::halfvec)`.as(
        "sim",
      ),
    ])
    .where("centroid_embedding", "is not", null)
    .orderBy(sql`centroid_embedding <=> ${embeddingVec}::halfvec`)
    .limit(1)
    .executeTakeFirst();

  if (!row || row.sim < threshold) return null;

  const recent = await db
    .selectFrom("story")
    .select(["scorer_summary"])
    .where("theme_id", "=", row.id)
    .where("scored_at", "is not", null)
    .orderBy("scored_at", "desc")
    .limit(3)
    .execute();

  const recentSummaries = recent
    .map((r) => r.scorer_summary ?? "")
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
      "scorer_summary",
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
      one_line_summary: r.scorer_summary ?? "",
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

  // Payloads are written inline; the cold tier offloads them to R2 from
  // the retention stage once aged past storage.cold_tier_age_days, so
  // the scheduled pipeline never round-trips to R2. See docs/storage.md.
  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable("story")
      .set({
        scorer_model_id: modelId,
        scorer_prompt_version: promptVersion,
        raw_input: input as never,
        raw_output: output as never,
        payload_key: null,
        scorer_summary:
          output.summary && output.summary.trim() !== ""
            ? output.summary.trim()
            : null,
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
  storyTitle: string,
  embeddingVec: string,
  output: ScorerOutput,
): Promise<number | null> {
  const categoryId = await lookupCategoryId(output.classification.category);
  // theme.category_id is NOT NULL — skip theme creation when scorer gave
  // no valid category. Story stays theme-less; it's still scored.
  if (categoryId === null) return null;

  // Theme name = scorer summary if non-empty, else fall back to the
  // story's own title. Haiku sometimes returns an empty summary even
  // for non-early-rejected stories (the schema permits null/empty),
  // and "" makes the theme indistinguishable in the admin themes view.
  // The title is always non-empty so this guarantees a usable label.
  const nameFromSummary = output.summary.trim();
  const themeName = (nameFromSummary !== "" ? nameFromSummary : storyTitle)
    .slice(0, 200);

  const row = await db
    .insertInto("theme")
    .values({
      category_id: categoryId,
      name: themeName,
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
      sql<number>`1 - (centroid_embedding <=> ${embeddingVec}::halfvec)`.as(
        "sim",
      ),
    ])
    .where("centroid_embedding", "is not", null)
    .orderBy(sql`centroid_embedding <=> ${embeddingVec}::halfvec`)
    .limit(1)
    .executeTakeFirst();
  if (!row || row.sim < threshold) return null;
  return { id: row.id, category_id: row.category_id };
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
  // Optional prefilter knobs default gracefully so a repo without
  // migration 011 still scores single-pass.
  map["scorer.prefilter_model_id"] ??= null;
  map["scorer.prefilter_prompt_version"] ??= map["scorer.prompt_version"];
  map["scorer.prefilter_top_fraction"] ??= 0.3;
  map["scorer.prefilter_max_tokens"] ??= 1500;
  // Semantic-dedup knobs (migration 022). Default on so the scorer bill
  // drops immediately; threshold is conservative to avoid false inherits.
  map["scorer.dedup_enabled"] ??= true;
  map["scorer.dedup_similarity_threshold"] ??= 0.95;
  map["scorer.dedup_lookback_days"] ??= 3;
  // Theme-attach thresholds (migration 030). Defaults match the
  // constants that lived in code at that migration's time.
  map["theme.attach_threshold"] ??= 0.7;
  map["theme.create_recheck_threshold"] ??= 0.88;
  // Scorer client dispatch (migration 047). Defaults to anthropic so a
  // repo without the migration still scores through the Anthropic SDK.
  map["scorer.client"] ??= "anthropic";
  if (map["scorer.client"] !== "anthropic" && map["scorer.client"] !== "openai_compat") {
    throw new Error(
      `scorer.client must be "anthropic" or "openai_compat", got: ${String(map["scorer.client"])}`,
    );
  }
  // Off-peak guard (migration 048). Defaults false so flipping the
  // migration doesn't suddenly skip scoring on non-DeepSeek deployments.
  map["scorer.off_peak_only"] ??= false;
  return map as ConfigMap;
}
