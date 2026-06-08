
import { sql } from "kysely";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { db } from "../db/index.ts";
import { getPayload } from "../shared/cold-tier.ts";
import {
  buildHomeView,
  loadHomeStalenessThresholdDays,
  mapIssueRow,
} from "../shared/issue-loaders.ts";
import { loadRawPrompt } from "../shared/prompts.ts";
import { extractHost, normalizeHost } from "../shared/source-blocklist.ts";
import { lintGloss } from "../shared/gloss-lint.ts";
import { loadGlossTerms } from "../shared/gloss-store.ts";
import type {
  ConfigRow,
} from "../views/admin-config.tsx";
import type {
  CostDashboardData,
} from "../views/admin-costs.tsx";
import type {
  EvalCandidate,
  EvalStats,
} from "../views/admin-eval.tsx";
import type {
  ExplorerData,
} from "../views/admin-explore.tsx";
import type {
  GateSandboxData,
} from "../views/admin-explore-gate.tsx";
import type {
  StoriesData,
  StoryFilter,
  GateFilter,
  SortKey,
  SortDir,
} from "../views/admin-explore-stories.tsx";
import type {
  DroppedData,
  DroppedFilter,
} from "../views/admin-explore-dropped.tsx";
import type {
  BalanceData,
  BalanceFilter,
} from "../views/admin-explore-balance.tsx";
import type {
  StoryDrilldown,
} from "../views/admin-explore-story.tsx";
import type {
  FixtureFile,
} from "../views/admin-fixtures.tsx";
import type {
  AdminIssueRow,
} from "../views/admin-issues.tsx";
import type {
  PromptEditorData,
  PromptStageKey,
} from "../views/admin-prompts.tsx";
import {
  decorateBriefHtml,
  type Annotation,
  type EditorReviewData,
} from "../views/admin-review.tsx";
import type {
  ThemeRow,
  ThemesData,
  ThemeFilter,
} from "../views/admin-themes.tsx";
import type {
  ThemeDetailData,
  ThemeMember,
} from "../views/admin-theme-detail.tsx";
import type {
  GraphEdge,
  GraphNode,
  ThemeGraphData,
} from "../views/admin-theme-graph.tsx";
import type {
  HostSortDir,
  HostSortKey,
  SourcesData,
} from "../views/admin-sources.tsx";
import type {
  ReviewersData,
} from "../views/admin-reviewers.tsx";
import type {
  PathFiltersData,
  PathFilterRow,
} from "../views/admin-path-filters.tsx";
import type {
  TitleFiltersData,
  TitleFilterRow,
} from "../views/admin-title-filters.tsx";
import type { GlossTermsData } from "../views/admin-gloss-terms.tsx";
import type {
  SchedulerData,
  SchedulerStageRow,
} from "../views/admin-scheduler.tsx";
import {
  listStages as listSchedulerStages,
} from "../scheduler.ts";
import type {
  EditorSandboxData,
  SandboxBucket,
} from "../views/admin-editor-sandbox.tsx";
import { selectEditorPool } from "../shared/editor-pool.ts";
import type { ArchiveEntry } from "../views/archive.tsx";
import type {
  DraftPreviewData,
} from "../views/draft-preview.tsx";
import type {
  Category as ManageCategory,
  ManageData,
} from "../views/manage.tsx";
import type { Flash, HomeViewData } from "../views/home.tsx";
import type { IssueView } from "../views/issue.tsx";
import type { ThemeViewData } from "../views/theme.tsx";

// --- data loaders ---

// Compose the home-page state. If the most recent issue is older than
// `home.staleness_threshold_days`, the front page goes quiet — see
// migration 042. Returns the surrogate id + public seq of the
// most-recent issue so the silence panel can deep-link it.
export async function loadHome(): Promise<HomeViewData> {
  const [latest, thresholdDays] = await Promise.all([
    loadLatestIssue(),
    loadHomeStalenessThresholdDays(),
  ]);
  return buildHomeView(latest, thresholdDays);
}

export async function loadLatestIssue(): Promise<IssueView | null> {
  const row = await db
    .selectFrom("issue")
    .select(["id", "published_seq", "published_at", "is_event_driven", "title", "composed_html"])
    .where("is_draft", "=", false)
    .orderBy("published_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return row ? mapIssueRow(row) : null;
}

export async function loadIssue(id: number): Promise<IssueView | null> {
  const row = await db
    .selectFrom("issue")
    .select(["id", "published_seq", "published_at", "is_event_driven", "title", "composed_html"])
    .where("id", "=", id)
    .where("is_draft", "=", false)
    .executeTakeFirst();
  return row ? mapIssueRow(row) : null;
}

// Load a draft for the reviewer preview page. Only returns drafts —
// published issues use the normal /issue/:id route. Published_at is
// used for display only; on a draft it's set when compose ran, not
// when the issue ships.
export async function loadDraftForPreview(
  id: number,
): Promise<DraftPreviewData["issue"] | null> {
  const row = await db
    .selectFrom("issue")
    .select(["id", "published_at", "title", "composed_html"])
    .where("id", "=", id)
    .where("is_draft", "=", true)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: Number(row.id),
    publishedAt: row.published_at,
    title: row.title,
    composedHtml: row.composed_html,
  };
}

export function parseDraftFlash(
  noted: string | undefined,
  error: string | undefined,
): { kind: "ok"; msg: string } | { kind: "err"; msg: string } | null {
  if (noted === "1") return { kind: "ok", msg: "Note added. Thanks." };
  if (error === "empty")
    return { kind: "err", msg: "Note was empty — write something first." };
  if (error === "too_long")
    return { kind: "err", msg: "Note is too long (5000 chars max)." };
  return null;
}

export async function listFixtures(): Promise<FixtureFile[]> {
  const dir = resolve("fixtures");
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: FixtureFile[] = [];
  for (const name of names) {
    const isJsonl = name.endsWith(".jsonl");
    const isComposerHtml = name.startsWith("composer-replay-") && name.endsWith(".html");
    const isComposerDiff = name.startsWith("composer-replay-") && name.endsWith(".diff.md");
    const isEditorDiff = name.startsWith("editor-replay-") && name.endsWith(".diff.md");
    const isEditorJson = name.startsWith("editor-replay-") && name.endsWith(".json");
    if (!isJsonl && !isComposerHtml && !isComposerDiff && !isEditorDiff && !isEditorJson) {
      continue;
    }
    const st = await stat(resolve(dir, name)).catch(() => null);
    if (st === null) continue;
    const kind: FixtureFile["kind"] = isComposerHtml || isComposerDiff
      ? "composer-replay"
      : isEditorDiff || isEditorJson
        ? "editor-replay"
        : name.startsWith("capture-")
          ? "capture"
          : name.startsWith("replay-")
            ? "replay"
            : "unknown";
    out.push({ name, sizeBytes: st.size, mtime: st.mtime, kind });
  }
  out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return out;
}

export async function loadCostData(): Promise<CostDashboardData> {
  const since = new Date(Date.now() - 14 * 24 * 3600_000);
  const dayStart = new Date(
    Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()),
  );

  const rows = await db
    .selectFrom("ai_call_log")
    .select([
      sql<string>`to_char(date_trunc('day', started_at at time zone 'UTC'), 'YYYY-MM-DD')`.as(
        "day",
      ),
      "stage_name",
      sql<string>`count(*)`.as("calls"),
      sql<string | null>`coalesce(sum(cost_estimate_usd), 0)`.as("cost"),
    ])
    .where("started_at", ">=", dayStart)
    .groupBy(["day", "stage_name"])
    .orderBy("day", "desc")
    .execute();

  // Bucket by day
  const byDay = new Map<string, {
    calls: number;
    cost: number;
    byStage: Record<string, number>;
  }>();
  const stageTotalsMap = new Map<string, { calls: number; cost: number }>();
  const knownStages = new Set<string>();
  for (const r of rows) {
    const calls = Number(r.calls);
    const cost = Number(r.cost ?? 0);
    knownStages.add(r.stage_name);
    const bucket = byDay.get(r.day) ?? { calls: 0, cost: 0, byStage: {} };
    bucket.calls += calls;
    bucket.cost += cost;
    bucket.byStage[r.stage_name] = (bucket.byStage[r.stage_name] ?? 0) + cost;
    byDay.set(r.day, bucket);

    const s = stageTotalsMap.get(r.stage_name) ?? { calls: 0, cost: 0 };
    s.calls += calls;
    s.cost += cost;
    stageTotalsMap.set(r.stage_name, s);
  }

  // Fill in missing days (zero-spend) so the chart has a continuous x-axis.
  const daily: CostDashboardData["daily"] = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(Date.now() - i * 24 * 3600_000);
    const key = d.toISOString().slice(0, 10);
    const b = byDay.get(key) ?? { calls: 0, cost: 0, byStage: {} };
    daily.push({
      day: key,
      calls: b.calls,
      costUsd: b.cost,
      byStage: b.byStage,
    });
  }

  const todayKey = new Date().toISOString().slice(0, 10);
  const todaySpend = byDay.get(todayKey)?.cost ?? 0;

  const capRow = await db
    .selectFrom("config")
    .select("value")
    .where("key", "=", "budget.daily_usd_cap")
    .executeTakeFirst();
  const cap = capRow
    ? Number(typeof capRow.value === "number" ? capRow.value : capRow.value)
    : null;

  const stageTotals = [...stageTotalsMap.entries()]
    .map(([stage, v]) => ({ stage, calls: v.calls, costUsd: v.cost }))
    .sort((a, b) => b.costUsd - a.costUsd);

  return {
    daily,
    stageTotals,
    todaySpend,
    dailyCap: cap !== null && Number.isFinite(cap) ? cap : null,
    knownStages: [...knownStages].sort(),
  };
}

// --- Explorer loaders ---

export function clampInt(
  raw: string | undefined,
  lo: number,
  hi: number,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

export async function loadExplorerData(): Promise<ExplorerData> {
  const since30 = new Date(Date.now() - 30 * 24 * 3600_000);

  // Corpus counts — plain queries, one per metric. Not hot, keep simple.
  const n = (v: string | number | bigint | null | undefined): number =>
    v === null || v === undefined ? 0 : Number(v);
  const [
    totalRow,
    ingested30Row,
    scoredRow,
    scored30Row,
    passedRow,
    passed30Row,
    rejectedRow,
    publishedRow,
    themesRow,
    issuesRow,
  ] = await Promise.all([
    db.selectFrom("story").select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow(),
    db
      .selectFrom("story")
      .select(sql<string>`count(*)`.as("n"))
      .where("ingested_at", ">=", since30)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("story")
      .select(sql<string>`count(*)`.as("n"))
      .where("scored_at", "is not", null)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("story")
      .select(sql<string>`count(*)`.as("n"))
      .where("scored_at", ">=", since30)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("story")
      .select(sql<string>`count(*)`.as("n"))
      .where("passed_gate", "=", true)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("story")
      .select(sql<string>`count(*)`.as("n"))
      .where("passed_gate", "=", true)
      .where("scored_at", ">=", since30)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("story")
      .select(sql<string>`count(*)`.as("n"))
      .where("early_reject", "=", true)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("story")
      .select(sql<string>`count(*)`.as("n"))
      .where("published_to_reader", "=", true)
      .executeTakeFirstOrThrow(),
    db.selectFrom("theme").select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow(),
    db
      .selectFrom("issue")
      .select(sql<string>`count(*)`.as("n"))
      .where("is_draft", "=", false)
      .executeTakeFirstOrThrow(),
  ]);
  const corpusRow = {
    total: n(totalRow.n),
    ingested_30: n(ingested30Row.n),
    scored: n(scoredRow.n),
    scored_30: n(scored30Row.n),
    passed: n(passedRow.n),
    passed_30: n(passed30Row.n),
    rejected: n(rejectedRow.n),
    published: n(publishedRow.n),
    themes: n(themesRow.n),
    issues: n(issuesRow.n),
  };

  // Score vectors over the last 30d.
  const scored = await db
    .selectFrom("story")
    .select([
      "composite",
      "zeitgeist_score",
      "half_life",
      "reach",
      "non_obviousness",
      "structural_importance",
    ])
    .where("scored_at", ">=", since30)
    .where("early_reject", "=", false)
    .execute();

  const composites = scored
    .map((r) => (r.composite !== null ? Number(r.composite) : null))
    .filter((v): v is number => v !== null);
  const zeitgeist = scored
    .map((r) => r.zeitgeist_score)
    .filter((v): v is number => v !== null);
  const halfLife = scored
    .map((r) => r.half_life)
    .filter((v): v is number => v !== null);
  const reach = scored
    .map((r) => r.reach)
    .filter((v): v is number => v !== null);
  const nonObviousness = scored
    .map((r) => r.non_obviousness)
    .filter((v): v is number => v !== null);
  const structural = scored
    .map((r) => r.structural_importance)
    .filter((v): v is number => v !== null);

  // Per-day timeline (scored + passed) for the last 30 days.
  const perDayRaw = await db
    .selectFrom("story")
    .select([
      sql<string>`to_char(date_trunc('day', scored_at at time zone 'UTC'), 'YYYY-MM-DD')`.as(
        "day",
      ),
      sql<string>`count(*)`.as("count"),
      sql<string>`count(*) filter (where passed_gate = true)`.as("passed"),
    ])
    .where("scored_at", ">=", since30)
    .groupBy("day")
    .orderBy("day", "asc")
    .execute();
  const perDayMap = new Map<string, { count: number; passed: number }>();
  for (const r of perDayRaw)
    perDayMap.set(r.day, {
      count: Number(r.count),
      passed: Number(r.passed),
    });
  const perDay: ExplorerData["perDay"] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 3600_000)
      .toISOString()
      .slice(0, 10);
    const b = perDayMap.get(d) ?? { count: 0, passed: 0 };
    perDay.push({ day: d, count: b.count, passed: b.passed });
  }

  // Factor frequencies (top 10 per kind, last 30d).
  const factorRows = await db
    .selectFrom("story_factor")
    .innerJoin("story", "story.id", "story_factor.story_id")
    .select([
      "story_factor.kind",
      "story_factor.factor",
      sql<string>`count(*)`.as("n"),
    ])
    .where("story.scored_at", ">=", since30)
    .groupBy(["story_factor.kind", "story_factor.factor"])
    .execute();
  const byKind: Record<string, Array<{ label: string; value: number }>> = {
    trigger: [],
    penalty: [],
    uncertainty: [],
  };
  for (const r of factorRows) {
    (byKind[r.kind] ?? byKind["uncertainty"]!).push({
      label: r.factor,
      value: Number(r.n),
    });
  }
  const triggers = (byKind["trigger"] ?? [])
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
  const penalties = (byKind["penalty"] ?? [])
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
  const uncertainties = (byKind["uncertainty"] ?? [])
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  // Per-category (total + passed within last 30d).
  const catRows = await db
    .selectFrom("story")
    .leftJoin("category", "category.id", "story.category_id")
    .select([
      sql<string | null>`category.slug`.as("slug"),
      sql<string>`count(*)`.as("n"),
      sql<string>`count(*) filter (where passed_gate = true)`.as("passed"),
    ])
    .where("story.scored_at", ">=", since30)
    .groupBy(sql`category.slug`)
    .execute();
  const byCategory = catRows
    .map((r) => ({
      label: r.slug ?? "—",
      value: Number(r.n),
      sublabel: Number(r.passed) > 0 ? `▸ ${r.passed}` : undefined,
    }))
    .sort((a, b) => b.value - a.value);

  // Confidence breakdown (last 30d).
  const confRows = await db
    .selectFrom("story")
    .select([
      "point_in_time_confidence",
      sql<string>`count(*)`.as("n"),
    ])
    .where("scored_at", ">=", since30)
    .where("point_in_time_confidence", "is not", null)
    .groupBy("point_in_time_confidence")
    .execute();
  const byConfidence = confRows
    .map((r) => ({
      label: r.point_in_time_confidence ?? "—",
      value: Number(r.n),
    }))
    .sort((a, b) => b.value - a.value);

  // Per-source (last 30d, by ingest).
  const sourceRows = await db
    .selectFrom("story")
    .select(["source_name", sql<string>`count(*)`.as("n")])
    .where("ingested_at", ">=", since30)
    .groupBy("source_name")
    .execute();
  const bySource = sourceRows
    .map((r) => ({ label: r.source_name, value: Number(r.n) }))
    .sort((a, b) => b.value - a.value);

  return {
    corpus: {
      total: Number(corpusRow.total),
      ingested_last_30d: Number(corpusRow.ingested_30),
      scored: Number(corpusRow.scored),
      scored_last_30d: Number(corpusRow.scored_30),
      passed: Number(corpusRow.passed),
      passed_last_30d: Number(corpusRow.passed_30),
      early_rejected: Number(corpusRow.rejected),
      published: Number(corpusRow.published),
      themes: Number(corpusRow.themes),
      issues: Number(corpusRow.issues),
    },
    composites,
    zeitgeist,
    halfLife,
    reach,
    nonObviousness,
    structural,
    perDay,
    triggers,
    penalties,
    uncertainties,
    byCategory,
    byConfidence,
    bySource,
  };
}

export function parseStoryFilter(q: Record<string, string>): StoryFilter {
  const gate = (["pass", "fail", "reject", "any"] as const).includes(
    q.gate as GateFilter,
  )
    ? (q.gate as GateFilter)
    : undefined;
  const sort = (
    [
      "composite",
      "zeitgeist",
      "half_life",
      "structural",
      "non_obviousness",
      "reach",
      "published",
      "scored",
      "ingested",
    ] as const
  ).includes(q.sort as SortKey)
    ? (q.sort as SortKey)
    : undefined;
  const dir: SortDir | undefined =
    q.dir === "asc" || q.dir === "desc" ? (q.dir as SortDir) : undefined;
  const page = Math.max(1, Number(q.page) || 1);
  const minComposite = q.min !== undefined && q.min !== "" ? Number(q.min) : undefined;
  const maxComposite = q.max !== undefined && q.max !== "" ? Number(q.max) : undefined;
  return {
    q: q.q || undefined,
    category: q.category || undefined,
    source: q.source || undefined,
    confidence: q.conf || undefined,
    factor: q.factor || undefined,
    noise: q.noise || undefined,
    gate,
    sort,
    dir,
    page,
    minComposite:
      minComposite !== undefined && Number.isFinite(minComposite)
        ? minComposite
        : undefined,
    maxComposite:
      maxComposite !== undefined && Number.isFinite(maxComposite)
        ? maxComposite
        : undefined,
  };
}

export function normalizePathPattern(raw: string): string | null {
  // Lowercased, leading/trailing slashes preserved if present, and a
  // hard length cap to keep the table readable. Empty after trim → null.
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  return trimmed;
}

export async function loadPathFiltersData(
  flash: PathFiltersData["flash"],
): Promise<PathFiltersData> {
  const filterRows = await db
    .selectFrom("url_path_filter")
    .select(["pattern", "mode", "hits", "note", "created_at"])
    .orderBy("mode", "asc")
    .orderBy("pattern", "asc")
    .execute();

  // Live counts: how many persisted stories currently match each
  // tag-mode pattern. Useful for spot-checking false positives before
  // promoting to block. Block-mode rows always read 0 because those
  // stories were dropped at ingest.
  const tagPatterns = filterRows
    .filter((r) => r.mode === "tag")
    .map((r) => r.pattern);
  const liveCountMap = new Map<string, number>();
  if (tagPatterns.length > 0) {
    const liveRows = await db
      .selectFrom("story")
      .select([
        "noise_pattern",
        sql<string>`count(*)`.as("n"),
      ])
      .where("noise_pattern", "in", tagPatterns)
      .groupBy("noise_pattern")
      .execute();
    for (const r of liveRows) {
      if (r.noise_pattern !== null) liveCountMap.set(r.noise_pattern, Number(r.n));
    }
  }

  const rows: PathFilterRow[] = filterRows.map((r) => ({
    pattern: r.pattern,
    mode: r.mode === "block" ? "block" : "tag",
    hits: r.hits,
    note: r.note,
    createdAt: r.created_at,
    liveStoryCount: liveCountMap.get(r.pattern) ?? 0,
  }));
  return { rows, flash };
}

export async function loadTitleFiltersData(
  flash: TitleFiltersData["flash"],
): Promise<TitleFiltersData> {
  const filterRows = await db
    .selectFrom("title_regex_filter")
    .select(["pattern", "mode", "hits", "note", "created_at"])
    .orderBy("mode", "asc")
    .orderBy("pattern", "asc")
    .execute();

  // Live counts only for tag-mode rows (block-mode stories were
  // dropped at ingest, so noise_title_pattern is never set for them).
  const tagPatterns = filterRows
    .filter((r) => r.mode === "tag")
    .map((r) => r.pattern);
  const liveCountMap = new Map<string, number>();
  if (tagPatterns.length > 0) {
    const liveRows = await db
      .selectFrom("story")
      .select([
        "noise_title_pattern",
        sql<string>`count(*)`.as("n"),
      ])
      .where("noise_title_pattern", "in", tagPatterns)
      .groupBy("noise_title_pattern")
      .execute();
    for (const r of liveRows) {
      if (r.noise_title_pattern !== null) {
        liveCountMap.set(r.noise_title_pattern, Number(r.n));
      }
    }
  }

  const rows: TitleFilterRow[] = filterRows.map((r) => ({
    pattern: r.pattern,
    mode: r.mode === "block" ? "block" : "tag",
    hits: r.hits,
    note: r.note,
    createdAt: r.created_at,
    liveStoryCount: liveCountMap.get(r.pattern) ?? 0,
  }));
  return { rows, flash };
}

export async function loadGlossTermsData(
  flash: GlossTermsData["flash"],
): Promise<GlossTermsData> {
  const rows = await db
    .selectFrom("gloss_term")
    .select(["term", "note", "hits", "created_at"])
    .orderBy("hits", "desc")
    .orderBy("term", "asc")
    .execute();
  return {
    rows: rows.map((r) => ({
      term: r.term,
      note: r.note,
      hits: r.hits,
      createdAt: r.created_at,
    })),
    flash,
  };
}

export async function loadSchedulerData(
  flash: SchedulerData["flash"],
): Promise<SchedulerData> {
  const stages = listSchedulerStages();
  const scheduleRows = await db
    .selectFrom("pipeline_schedule")
    .select(["stage", "interval_sec", "enabled"])
    .execute();
  const scheduleMap = new Map(scheduleRows.map((r) => [r.stage, r]));

  const lockRows = await db
    .selectFrom("pipeline_lock")
    .select(["stage_name", "expires_at"])
    .execute();
  const lockMap = new Map(lockRows.map((r) => [r.stage_name, r.expires_at]));

  const forceRows = await db
    .selectFrom("pipeline_force_run")
    .select("stage")
    .execute();
  const forceSet = new Set(forceRows.map((r) => r.stage));

  const now = Date.now();
  const out: SchedulerStageRow[] = [];
  for (const job of stages) {
    const cfg = scheduleMap.get(job.stage);
    const intervalSec = cfg?.interval_sec ?? 0;
    const enabled = cfg?.enabled ?? false;

    const lastSuccessRow = await db
      .selectFrom("pipeline_run")
      .select(["completed_at"])
      .where("stage", "=", job.stage)
      .where("status", "=", "success")
      .orderBy("completed_at", "desc")
      .limit(1)
      .executeTakeFirst();
    const lastSuccessAt = lastSuccessRow?.completed_at ?? null;

    const lastAttemptRow = await db
      .selectFrom("pipeline_run")
      .select([
        "started_at",
        "status",
        "error",
        "progress_done",
        "progress_total",
      ])
      .where("stage", "=", job.stage)
      .orderBy("started_at", "desc")
      .limit(1)
      .executeTakeFirst();

    // Don't surface the error string after a subsequent successful
    // run — keeps the column from showing stale failures.
    const showError =
      lastAttemptRow?.status === "error" &&
      (lastSuccessAt === null ||
        (lastAttemptRow.started_at !== null &&
          lastAttemptRow.started_at > lastSuccessAt));

    const nextDueAt =
      cfg !== undefined && lastSuccessAt !== null
        ? new Date(lastSuccessAt.getTime() + intervalSec * 1000)
        : cfg !== undefined
          ? new Date(now)
          : null;

    out.push({
      stage: job.stage,
      intervalSec,
      enabled,
      lastSuccessAt,
      lastSuccessAgeSec:
        lastSuccessAt !== null
          ? Math.floor((now - lastSuccessAt.getTime()) / 1000)
          : null,
      lastAttemptAt: lastAttemptRow?.started_at ?? null,
      lastAttemptStatus: lastAttemptRow?.status ?? null,
      lastError: showError ? (lastAttemptRow?.error ?? null) : null,
      nextDueAt,
      lockHeldUntil: lockMap.get(job.stage) ?? null,
      forceQueued: forceSet.has(job.stage),
      progressDone:
        lastAttemptRow?.status === "running"
          ? (lastAttemptRow.progress_done ?? null)
          : null,
      progressTotal:
        lastAttemptRow?.status === "running"
          ? (lastAttemptRow.progress_total ?? null)
          : null,
    });
  }
  return { rows: out, flash };
}

export async function loadStoriesData(filter: StoryFilter): Promise<StoriesData> {
  const pageSize = 50;
  const page = Math.max(1, filter.page ?? 1);

  let q = db
    .selectFrom("story")
    .leftJoin("category", "category.id", "story.category_id")
    .leftJoin("theme", "theme.id", "story.theme_id");

  if (filter.q && filter.q.length > 0) {
    q = q.where("story.title", "ilike", `%${filter.q}%`);
  }
  if (filter.category) {
    q = q.where("category.slug", "=", filter.category);
  }
  if (filter.source) {
    q = q.where("story.source_name", "=", filter.source);
  }
  if (filter.confidence) {
    q = q.where("story.point_in_time_confidence", "=", filter.confidence);
  }
  if (filter.gate === "pass") {
    q = q.where("story.passed_gate", "=", true);
  } else if (filter.gate === "fail") {
    q = q
      .where("story.passed_gate", "=", false)
      .where("story.early_reject", "=", false)
      .where("story.scored_at", "is not", null);
  } else if (filter.gate === "reject") {
    q = q.where("story.early_reject", "=", true);
  }
  if (filter.minComposite !== undefined) {
    q = q.where("story.composite", ">=", String(filter.minComposite));
  }
  if (filter.maxComposite !== undefined) {
    q = q.where("story.composite", "<=", String(filter.maxComposite));
  }
  if (filter.factor) {
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom("story_factor")
          .select("story_id")
          .whereRef("story_factor.story_id", "=", "story.id")
          .where("story_factor.factor", "=", filter.factor!),
      ),
    );
  }
  if (filter.noise === "flagged") {
    q = q.where("story.noise_pattern", "is not", null);
  } else if (filter.noise === "clean") {
    q = q.where("story.noise_pattern", "is", null);
  } else if (filter.noise) {
    q = q.where("story.noise_pattern", "=", filter.noise);
  }

  const countRow = await q
    .select(sql<string>`count(*)`.as("n"))
    .executeTakeFirstOrThrow();
  const total = Number(countRow.n);

  const sort: SortKey = filter.sort ?? "composite";
  const dir: SortDir = filter.dir ?? "desc";
  const sortColMap: Record<SortKey, string> = {
    composite: "story.composite",
    zeitgeist: "story.zeitgeist_score",
    half_life: "story.half_life",
    structural: "story.structural_importance",
    non_obviousness: "story.non_obviousness",
    reach: "story.reach",
    published: "story.published_at",
    scored: "story.scored_at",
    ingested: "story.ingested_at",
  };
  const sortCol = sortColMap[sort];
  // NULLS LAST so unscored stories don't dominate the default DESC view
  // — they go to the bottom regardless of direction.
  const orderExpr = sql`${sql.raw(sortCol)} ${sql.raw(dir.toUpperCase())} NULLS LAST, story.id DESC`;

  const rawRows = await q
    .select([
      "story.id",
      "story.title",
      "story.source_name as source",
      "category.slug as category_slug",
      "theme.id as theme_id",
      "theme.name as theme_name",
      "story.composite",
      "story.zeitgeist_score",
      "story.half_life",
      "story.structural_importance",
      "story.non_obviousness",
      "story.reach",
      "story.point_in_time_confidence",
      "story.passed_gate",
      "story.early_reject",
      "story.published_at",
      "story.scored_at",
      "story.noise_pattern",
    ])
    .orderBy(orderExpr)
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .execute();

  const ids = rawRows.map((r) => Number(r.id));
  const factorMap = new Map<number, string[]>();
  if (ids.length > 0) {
    const fRows = await db
      .selectFrom("story_factor")
      .select(["story_id", "factor"])
      .where("story_id", "in", ids)
      .execute();
    for (const r of fRows) {
      const k = Number(r.story_id);
      const list = factorMap.get(k) ?? [];
      list.push(r.factor);
      factorMap.set(k, list);
    }
  }

  const [cats, srcs, facs, noises] = await Promise.all([
    db.selectFrom("category").select("slug").orderBy("slug").execute(),
    db
      .selectFrom("story")
      .select("source_name")
      .distinct()
      .orderBy("source_name")
      .execute(),
    db
      .selectFrom("story_factor")
      .select("factor")
      .distinct()
      .orderBy("factor")
      .execute(),
    db
      .selectFrom("story")
      .select("noise_pattern")
      .distinct()
      .where("noise_pattern", "is not", null)
      .orderBy("noise_pattern")
      .execute(),
  ]);

  return {
    filter,
    total,
    page,
    pageSize,
    categories: cats.map((r) => r.slug),
    sources: srcs.map((r) => r.source_name),
    factors: facs.map((r) => r.factor),
    noisePatterns: noises
      .map((r) => r.noise_pattern)
      .filter((p): p is string => p !== null),
    rows: rawRows.map((r) => ({
      id: Number(r.id),
      title: r.title,
      source: r.source,
      category: r.category_slug,
      themeId: r.theme_id !== null ? Number(r.theme_id) : null,
      themeName: r.theme_name,
      composite: r.composite !== null ? Number(r.composite) : null,
      zeitgeist: r.zeitgeist_score,
      halfLife: r.half_life,
      structural: r.structural_importance,
      nonObviousness: r.non_obviousness,
      reach: r.reach,
      confidence: r.point_in_time_confidence,
      passedGate: r.passed_gate,
      earlyReject: r.early_reject,
      publishedAt: r.published_at,
      scoredAt: r.scored_at,
      factors: factorMap.get(Number(r.id)) ?? [],
      noisePattern: r.noise_pattern,
    })),
  };
}

export async function loadStoryDrilldown(id: number): Promise<StoryDrilldown | null> {
  const row = await db
    .selectFrom("story")
    .leftJoin("category", "category.id", "story.category_id")
    .leftJoin("theme", "theme.id", "story.theme_id")
    .selectAll("story")
    .select(["category.slug as category_slug", "theme.name as theme_name"])
    .where("story.id", "=", id)
    .executeTakeFirst();
  if (!row) return null;

  const factorRows = await db
    .selectFrom("story_factor")
    .select(["kind", "factor"])
    .where("story_id", "=", id)
    .execute();
  const factors = { trigger: [] as string[], penalty: [] as string[], uncertainty: [] as string[] };
  for (const r of factorRows) {
    (factors as Record<string, string[]>)[r.kind]?.push(r.factor);
  }

  // Resolve cold-stored raw_input/raw_output (mig 058) from the object
  // store when the payload was offloaded.
  let rawInput = row.raw_input;
  let rawOutput = row.raw_output;
  if (row.payload_key !== null) {
    const env = await getPayload(row.payload_key);
    if (env !== null) {
      rawInput = env.input as typeof rawInput;
      rawOutput = env.output as typeof rawOutput;
    }
  }

  return {
    id: Number(row.id),
    title: row.title,
    summary: row.summary,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    sourceHost: extractHost(row.source_url),
    noisePattern: row.noise_pattern,
    additionalSourceUrls: row.additional_source_urls ?? [],
    publishedAt: row.published_at,
    ingestedAt: row.ingested_at,
    scoredAt: row.scored_at,
    category: row.category_slug,
    themeId: row.theme_id !== null ? Number(row.theme_id) : null,
    themeName: row.theme_name,
    themeRelationship: row.theme_relationship,
    composite: row.composite !== null ? Number(row.composite) : null,
    zeitgeist: row.zeitgeist_score,
    halfLife: row.half_life,
    reach: row.reach,
    nonObviousness: row.non_obviousness,
    structural: row.structural_importance,
    confidence: row.point_in_time_confidence,
    baseRatePerYear:
      row.base_rate_per_year !== null ? Number(row.base_rate_per_year) : null,
    firstPassComposite:
      row.first_pass_composite !== null
        ? Number(row.first_pass_composite)
        : null,
    firstPassModel: row.first_pass_model_id,
    passedGate: row.passed_gate,
    earlyReject: row.early_reject,
    publishedToReader: row.published_to_reader,
    publishedToReaderAt: row.published_to_reader_at,
    scorerModel: row.scorer_model_id,
    scorerPromptVersion: row.scorer_prompt_version,
    factors,
    rawInput,
    rawOutput,
  };
}

export function parseDroppedFilter(q: Record<string, string>): DroppedFilter {
  const win = Number(q.window);
  const windowDays = [7, 14, 30, 60, 90].includes(win) ? win : 30;
  return { windowDays, category: q.category || undefined };
}

export async function loadDroppedData(filter: DroppedFilter): Promise<DroppedData> {
  const since = new Date(Date.now() - filter.windowDays * 24 * 3600_000);

  let base = db
    .selectFrom("story")
    .leftJoin("category", "category.id", "story.category_id")
    .where("story.scored_at", ">=", since);
  if (filter.category) {
    base = base.where("category.slug", "=", filter.category);
  }

  // Aggregate counts in one pass.
  const totalsRows = await base
    .select([
      sql<string>`count(*)`.as("scored"),
      sql<string>`count(*) FILTER (WHERE story.passed_gate = true)`.as("passed"),
      sql<string>`count(*) FILTER (WHERE story.passed_gate = false AND story.early_reject = false)`.as("dropped"),
      sql<string>`count(*) FILTER (WHERE story.early_reject = true)`.as("rejected"),
    ])
    .executeTakeFirstOrThrow();

  // Composite arrays + component means split by gate outcome.
  const droppedScores = await base
    .select([
      "story.composite",
      "story.zeitgeist_score",
      "story.half_life",
      "story.reach",
      "story.non_obviousness",
      "story.structural_importance",
    ])
    .where("story.passed_gate", "=", false)
    .where("story.early_reject", "=", false)
    .execute();
  const passedScores = await base
    .select([
      "story.composite",
      "story.zeitgeist_score",
      "story.half_life",
      "story.reach",
      "story.non_obviousness",
      "story.structural_importance",
    ])
    .where("story.passed_gate", "=", true)
    .execute();

  const compMean = (rows: typeof droppedScores) => ({
    zeitgeist: avg(rows.map((r) => r.zeitgeist_score ?? 0)),
    halfLife: avg(rows.map((r) => r.half_life ?? 0)),
    reach: avg(rows.map((r) => r.reach ?? 0)),
    nonObviousness: avg(rows.map((r) => r.non_obviousness ?? 0)),
    structural: avg(rows.map((r) => r.structural_importance ?? 0)),
  });

  // Penalty factor frequency on dropped stories.
  let penaltyQ = db
    .selectFrom("story_factor as sf")
    .innerJoin("story as s", "s.id", "sf.story_id")
    .leftJoin("category as c", "c.id", "s.category_id")
    .where("sf.kind", "=", "penalty")
    .where("s.scored_at", ">=", since)
    .where("s.passed_gate", "=", false)
    .where("s.early_reject", "=", false);
  if (filter.category) {
    penaltyQ = penaltyQ.where("c.slug", "=", filter.category);
  }
  const penaltyRows = await penaltyQ
    .select([
      "sf.factor as factor",
      sql<string>`count(*)`.as("n"),
    ])
    .groupBy("sf.factor")
    .orderBy(sql`count(*)`, "desc")
    .limit(20)
    .execute();

  // Per-category drop rate (only categories with >=5 scored in window).
  const byCatRows = await db
    .selectFrom("story")
    .leftJoin("category", "category.id", "story.category_id")
    .where("story.scored_at", ">=", since)
    .select([
      sql<string>`coalesce(category.slug, 'unknown')`.as("category"),
      sql<string>`count(*)`.as("scored"),
      sql<string>`count(*) FILTER (WHERE story.passed_gate = true)`.as("passed"),
      sql<string>`count(*) FILTER (WHERE story.passed_gate = false AND story.early_reject = false)`.as("dropped"),
    ])
    .groupBy(sql`coalesce(category.slug, 'unknown')`)
    .having(sql<string>`count(*)`, ">=", "5")
    .orderBy(sql`count(*) FILTER (WHERE story.passed_gate = false AND story.early_reject = false)::float / NULLIF(count(*),0)`, "desc")
    .execute();

  // Top drops: highest-composite stories that didn't pass.
  let topQ = db
    .selectFrom("story")
    .leftJoin("category", "category.id", "story.category_id")
    .where("story.scored_at", ">=", since)
    .where("story.passed_gate", "=", false)
    .where("story.early_reject", "=", false);
  if (filter.category) {
    topQ = topQ.where("category.slug", "=", filter.category);
  }
  const topRows = await topQ
    .select([
      "story.id",
      "story.title",
      "category.slug as category_slug",
      "story.composite",
      "story.point_in_time_confidence",
    ])
    .orderBy(sql`story.composite DESC NULLS LAST`)
    .limit(40)
    .execute();
  const topIds = topRows.map((r) => Number(r.id));
  const topFactors = topIds.length
    ? await db
        .selectFrom("story_factor")
        .select(["story_id", "factor"])
        .where("story_id", "in", topIds)
        .where("kind", "=", "penalty")
        .execute()
    : [];
  const factorByStory = new Map<number, string[]>();
  for (const f of topFactors) {
    const k = Number(f.story_id);
    factorByStory.set(k, [...(factorByStory.get(k) ?? []), f.factor]);
  }

  const cats = await db
    .selectFrom("category")
    .select("slug")
    .orderBy("slug")
    .execute();

  return {
    filter,
    categories: cats.map((c) => c.slug),
    totals: {
      scored: Number(totalsRows.scored),
      passed: Number(totalsRows.passed),
      dropped: Number(totalsRows.dropped),
      early_rejected: Number(totalsRows.rejected),
    },
    composites: {
      dropped: droppedScores.map((r) => Number(r.composite ?? 0)),
      passed: passedScores.map((r) => Number(r.composite ?? 0)),
    },
    components: {
      dropped: compMean(droppedScores),
      passed: compMean(passedScores),
    },
    penaltiesOnDropped: penaltyRows.map((r) => ({
      label: r.factor,
      value: Number(r.n),
    })),
    byCategory: byCatRows.map((r) => ({
      category: String(r.category),
      scored: Number(r.scored),
      passed: Number(r.passed),
      dropped: Number(r.dropped),
      dropRate: Number(r.scored) > 0 ? Number(r.dropped) / Number(r.scored) : 0,
    })),
    topDrops: topRows.map((r) => ({
      id: Number(r.id),
      title: r.title,
      category: r.category_slug,
      composite: r.composite !== null ? Number(r.composite) : 0,
      confidence: r.point_in_time_confidence,
      factors: factorByStory.get(Number(r.id)) ?? [],
    })),
  };
}

export function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function parseBalanceFilter(q: Record<string, string>): BalanceFilter {
  const win = Number(q.window);
  const windowWeeks = [4, 8, 12, 26, 52].includes(win) ? win : 12;
  return { windowWeeks };
}

export async function loadBalanceData(filter: BalanceFilter): Promise<BalanceData> {
  const since = new Date(Date.now() - filter.windowWeeks * 7 * 24 * 3600_000);

  // Per-category totals across the window.
  const byCatRows = await db
    .selectFrom("story")
    .leftJoin("category", "category.id", "story.category_id")
    .where("story.ingested_at", ">=", since)
    .select([
      sql<string>`coalesce(category.slug, 'unknown')`.as("category"),
      sql<string>`count(*)`.as("ingested"),
      sql<string>`count(*) FILTER (WHERE story.scored_at IS NOT NULL)`.as("scored"),
      sql<string>`count(*) FILTER (WHERE story.passed_gate = true)`.as("passed"),
      sql<string>`count(*) FILTER (WHERE story.published_to_reader = true)`.as("published"),
    ])
    .groupBy(sql`coalesce(category.slug, 'unknown')`)
    .orderBy(sql`count(*) FILTER (WHERE story.passed_gate = true)`, "desc")
    .execute();

  const byCategory = byCatRows.map((r) => ({
    category: String(r.category),
    ingested: Number(r.ingested),
    scored: Number(r.scored),
    passed: Number(r.passed),
    published: Number(r.published),
  }));

  // Concentration index (Herfindahl). Computed on passers.
  const totalPassed = byCategory.reduce((a, c) => a + c.passed, 0);
  const hhi =
    totalPassed > 0
      ? byCategory.reduce((a, c) => {
          const share = c.passed / totalPassed;
          return a + share * share;
        }, 0)
      : 0;

  // Per-week × category passers, for stacked timeline.
  const weeklyRows = await db
    .selectFrom("story")
    .leftJoin("category", "category.id", "story.category_id")
    .where("story.scored_at", ">=", since)
    .where("story.passed_gate", "=", true)
    .select([
      sql<string>`to_char(date_trunc('week', story.scored_at), 'YYYY-MM-DD')`.as("week"),
      sql<string>`coalesce(category.slug, 'unknown')`.as("category"),
      sql<string>`count(*)`.as("n"),
    ])
    .groupBy(["week", "category"])
    .orderBy("week", "asc")
    .execute();

  const weekSet = new Set<string>();
  const catSet = new Set<string>();
  const cellMap = new Map<string, number>();
  for (const r of weeklyRows) {
    weekSet.add(String(r.week));
    catSet.add(String(r.category));
    cellMap.set(`${r.week}|${r.category}`, Number(r.n));
  }
  const weeks = [...weekSet].sort();
  const cats = [...catSet].sort();
  const weekly = weeks.map((week) => ({
    week,
    counts: Object.fromEntries(
      cats.map((cat) => [cat, cellMap.get(`${week}|${cat}`) ?? 0]),
    ),
  }));

  return {
    filter,
    byCategory,
    weekly,
    categories: cats,
    hhi,
    totalPassed,
  };
}

export async function loadGateSandboxData(params: {
  lookbackDays: number;
  xThreshold: number; // -1 means "use current"
  confidenceFloor: "low" | "medium" | "high" | null;
}): Promise<GateSandboxData> {
  // Load current gate config.
  const cfgRows = await db
    .selectFrom("config")
    .select(["key", "value"])
    .where("key", "in", ["gate.x_threshold", "gate.confidence_floor"])
    .execute();
  const cfgMap = new Map(cfgRows.map((r) => [r.key, r.value]));
  const currentX = Number(cfgMap.get("gate.x_threshold") ?? 5);
  const currentCF = (cfgMap.get("gate.confidence_floor") as
    | "low"
    | "medium"
    | "high"
    | undefined) ?? "medium";
  const proposedX = params.xThreshold >= 0 ? params.xThreshold : currentX;
  const proposedCF = params.confidenceFloor ?? currentCF;

  const since = new Date(Date.now() - params.lookbackDays * 24 * 3600_000);

  const rows = await db
    .selectFrom("story")
    .leftJoin("category", "category.id", "story.category_id")
    .select([
      "story.id",
      "story.title",
      "story.composite",
      "story.point_in_time_confidence",
      "story.passed_gate",
      "category.slug as category_slug",
    ])
    .where("story.scored_at", ">=", since)
    .where("story.early_reject", "=", false)
    .execute();

  const rank = (c: "low" | "medium" | "high" | null): number =>
    c === "high" ? 2 : c === "medium" ? 1 : c === "low" ? 0 : -1;

  const meetsProposed = (
    c: number | null,
    conf: "low" | "medium" | "high" | null,
  ) => c !== null && c >= proposedX && rank(conf) >= rank(proposedCF);

  const hypotheticalIds = new Set<number>();
  const currentPassers = rows.filter((r) => r.passed_gate).length;

  const catMap = new Map<string, number>();
  const newPass: typeof rows = [];
  const newFail: typeof rows = [];

  for (const r of rows) {
    const comp = r.composite !== null ? Number(r.composite) : null;
    const pass = meetsProposed(
      comp,
      r.point_in_time_confidence as "low" | "medium" | "high" | null,
    );
    if (pass) {
      hypotheticalIds.add(Number(r.id));
      const key = r.category_slug ?? "—";
      catMap.set(key, (catMap.get(key) ?? 0) + 1);
    }
    if (pass && !r.passed_gate) newPass.push(r);
    if (!pass && r.passed_gate) newFail.push(r);
  }

  // Eval set comparison if any labels exist for stories in this window.
  const labeled = await db
    .selectFrom("eval_label")
    .innerJoin("story", "story.id", "eval_label.story_id")
    .select([
      "eval_label.label",
      "story.id",
      "story.composite",
      "story.point_in_time_confidence",
    ])
    .where("story.scored_at", ">=", since)
    .execute();
  let evalSummary: GateSandboxData["evalSummary"] = null;
  if (labeled.length > 0) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const r of labeled) {
      const comp = r.composite !== null ? Number(r.composite) : null;
      const pass = meetsProposed(
        comp,
        r.point_in_time_confidence as "low" | "medium" | "high" | null,
      );
      if (r.label === "yes" && pass) tp++;
      if (r.label === "no" && pass) fp++;
      if (r.label === "yes" && !pass) fn++;
    }
    evalSummary = {
      labeled: labeled.length,
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      precision: tp + fp > 0 ? tp / (tp + fp) : 0,
      recall: tp + fn > 0 ? tp / (tp + fn) : 0,
    };
  }

  return {
    lookbackDays: params.lookbackDays,
    current: {
      xThreshold: currentX,
      confidenceFloor: currentCF,
      passers: currentPassers,
    },
    proposed: { xThreshold: proposedX, confidenceFloor: proposedCF },
    total: rows.length,
    hypotheticalPassers: hypotheticalIds.size,
    wouldNewlyPass: newPass
      .sort(
        (a, b) => Number(b.composite ?? 0) - Number(a.composite ?? 0),
      )
      .slice(0, 12)
      .map((r) => ({
        id: Number(r.id),
        title: r.title,
        composite: Number(r.composite ?? 0),
      })),
    wouldNewlyFail: newFail
      .sort(
        (a, b) => Number(b.composite ?? 0) - Number(a.composite ?? 0),
      )
      .slice(0, 12)
      .map((r) => ({
        id: Number(r.id),
        title: r.title,
        composite: Number(r.composite ?? 0),
      })),
    passersByCategory: [...catMap.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value),
    evalSummary,
  };
}

export async function loadEvalStats(): Promise<EvalStats> {
  const countsRow = await db
    .selectFrom("eval_label")
    .select(["label", sql<string>`count(*)`.as("n")])
    .groupBy("label")
    .execute();
  const counts: Record<string, number> = {};
  for (const r of countsRow) counts[r.label] = Number(r.n);
  const labeled = Object.values(counts).reduce((a, b) => a + b, 0);
  const totalRow = await db
    .selectFrom("story")
    .select(sql<string>`count(*)`.as("n"))
    .where("scored_at", "is not", null)
    .where("early_reject", "=", false)
    .executeTakeFirst();
  return {
    total: Number(totalRow?.n ?? 0),
    labeled,
    yes: counts["yes"] ?? 0,
    maybe: counts["maybe"] ?? 0,
    no: counts["no"] ?? 0,
    skip: counts["skip"] ?? 0,
  };
}

// Next unlabeled story: any scored, non-early-rejected story not yet in
// eval_label. Orders by composite DESC so we hit the interesting items
// first — the scorer's top picks are the ones that most need a second
// opinion.
export async function loadNextEvalCandidate(): Promise<EvalCandidate | null> {
  const row = await db
    .selectFrom("story")
    .leftJoin("category", "category.id", "story.category_id")
    .leftJoin("eval_label", "eval_label.story_id", "story.id")
    .select([
      "story.id",
      "story.title",
      "story.source_url",
      "category.slug as category_slug",
      "story.composite",
      "story.point_in_time_confidence",
      "story.raw_output",
      "story.payload_key",
      "story.ingested_at",
    ])
    .where("story.scored_at", "is not", null)
    .where("story.early_reject", "=", false)
    .where("eval_label.story_id", "is", null)
    .orderBy("story.composite", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  // raw_output carries retrodiction_12mo, which is not denormalized —
  // resolve it from the object store when cold-stored (mig 058).
  let rawOutput = row.raw_output;
  if (row.payload_key !== null) {
    const env = await getPayload(row.payload_key);
    if (env !== null) rawOutput = env.output as typeof rawOutput;
  }
  const r = rawOutput as
    | { summary?: string; reasoning?: { retrodiction_12mo?: string } }
    | null;
  return {
    story_id: Number(row.id),
    title: row.title,
    source_url: row.source_url,
    category: row.category_slug,
    composite: row.composite !== null ? Number(row.composite) : null,
    confidence: row.point_in_time_confidence,
    scorerOneLiner: r?.summary ?? "",
    retrodiction: r?.reasoning?.retrodiction_12mo ?? "",
    ingestedAt: row.ingested_at,
  };
}

export function parseThemeFilter(raw: string | undefined): ThemeFilter {
  if (raw === "long_running" || raw === "rising" || raw === "active") {
    return raw;
  }
  return "all";
}

export function parseFlashGeneric(
  saved: string | undefined,
  error: string | undefined,
): ThemesData["flash"] {
  if (saved) return { kind: "ok", msg: "Saved." };
  if (error === "bad_id") return { kind: "error", msg: "Bad theme id." };
  return null;
}

export async function loadReviewersData(
  q: Record<string, string>,
): Promise<ReviewersData> {
  const subs = await db
    .selectFrom("email_subscription")
    .select([
      "id",
      "email",
      "is_reviewer",
      "confirmed_at",
      "unsubscribed_at",
    ])
    // Reviewers first, then the rest of the subscriber list to promote
    // from; newest within each group.
    .orderBy("is_reviewer", "desc")
    .orderBy("created_at", "desc")
    .execute();

  // Last successful send per (subscriber, kind) for the "last draft /
  // last published sent" columns. One grouped scan, mapped in memory.
  const sendRows = await db
    .selectFrom("dispatch_log")
    .select(({ fn }) => [
      "subscription_id",
      "subscription_kind",
      fn.max("dispatched_at").as("last_at"),
    ])
    .where("subscription_kind", "in", ["draft", "email"])
    .where("status", "in", ["sent", "noop"])
    .groupBy(["subscription_id", "subscription_kind"])
    .execute();
  const draftSent = new Map<number, Date>();
  const pubSent = new Map<number, Date>();
  for (const r of sendRows) {
    const at = r.last_at as Date | null;
    if (at === null) continue;
    const target = r.subscription_kind === "draft" ? draftSent : pubSent;
    target.set(Number(r.subscription_id), at);
  }

  const rows = subs.map((s) => ({
    id: Number(s.id),
    email: s.email,
    isReviewer: s.is_reviewer,
    confirmedAt: s.confirmed_at,
    unsubscribedAt: s.unsubscribed_at,
    lastDraftSentAt: draftSent.get(Number(s.id)) ?? null,
    lastPublishedSentAt: pubSent.get(Number(s.id)) ?? null,
  }));

  const flash: ReviewersData["flash"] =
    q.added !== undefined
      ? { kind: "ok", msg: `Added ${q.added} as a reviewer.` }
      : q.promoted !== undefined
        ? { kind: "ok", msg: `${q.promoted} is now a reviewer.` }
        : q.demoted !== undefined
          ? { kind: "ok", msg: `${q.demoted} is no longer a reviewer.` }
          : q.error === "bad_email"
            ? { kind: "err", msg: "That doesn't look like a valid email." }
            : q.error === "no_subscription"
              ? { kind: "err", msg: "No such subscription." }
              : null;

  return { rows, flash };
}

export async function loadSourcesData(
  windowDays: number,
  sort: HostSortKey,
  dir: HostSortDir,
  q: Record<string, string>,
): Promise<SourcesData> {
  const since = new Date(Date.now() - windowDays * 24 * 3600_000);

  const blocklistRows = await db
    .selectFrom("source_blocklist")
    .select(["host", "reason", "blocked_at"])
    .orderBy("blocked_at", "desc")
    .execute();
  const blockedSet = new Set(blocklistRows.map((r) => normalizeHost(r.host)));

  // Per-connector ingestion totals. Surfaces "is GDELT actually
  // running?" directly — if a registered connector shows 0 in the
  // window, something is silently failing. Registered names come from
  // connectors/registry so a 0-row connector still appears (vs only
  // querying story.source_name, which would hide it).
  const { connectors: registered } = await import(
    "../connectors/registry.ts"
  );
  const ingestRows = await db
    .selectFrom("story")
    .select([
      "source_name",
      sql<string>`count(*)`.as("n"),
    ])
    .where("ingested_at", ">=", since)
    .groupBy("source_name")
    .execute();
  const ingestMap = new Map(
    ingestRows.map((r) => [r.source_name, Number(r.n)]),
  );

  // Pull the freshest error per connector_name from source_cursor.
  // RSS has many scopes (one per feed); we want the most recent error
  // across them — prioritize the row with the latest last_error_at
  // that has a non-null error, falling back to the latest run.
  const cursorRows = await db
    .selectFrom("source_cursor")
    .select([
      "connector_name",
      "last_error",
      "last_error_at",
      "last_run_at",
    ])
    .execute();
  const cursorByConnector = new Map<
    string,
    {
      lastError: string | null;
      lastErrorAt: Date | null;
      lastRunAt: Date | null;
    }
  >();
  for (const r of cursorRows) {
    const cur = cursorByConnector.get(r.connector_name);
    const incoming = {
      lastError: r.last_error,
      lastErrorAt: r.last_error_at,
      lastRunAt: r.last_run_at,
    };
    if (cur === undefined) {
      cursorByConnector.set(r.connector_name, incoming);
      continue;
    }
    // Prefer the row with the most recent last_error_at when both
    // have errors; for the run timestamp we always take the latest.
    const merged = {
      lastError:
        (incoming.lastErrorAt?.getTime() ?? -1) >
        (cur.lastErrorAt?.getTime() ?? -1)
          ? incoming.lastError
          : cur.lastError,
      lastErrorAt:
        (incoming.lastErrorAt?.getTime() ?? -1) >
        (cur.lastErrorAt?.getTime() ?? -1)
          ? incoming.lastErrorAt
          : cur.lastErrorAt,
      lastRunAt:
        (incoming.lastRunAt?.getTime() ?? -1) >
        (cur.lastRunAt?.getTime() ?? -1)
          ? incoming.lastRunAt
          : cur.lastRunAt,
    };
    cursorByConnector.set(r.connector_name, merged);
  }

  const byConnector = registered.map((c) => {
    const cursor = cursorByConnector.get(c.name);
    return {
      source: c.name,
      ingested: ingestMap.get(c.name) ?? 0,
      lastError: cursor?.lastError ?? null,
      lastErrorAt: cursor?.lastErrorAt ?? null,
      lastRunAt: cursor?.lastRunAt ?? null,
    };
  });
  // Tail any source_name in the data that isn't in the registry (old
  // connectors that have been removed) so the diagnostic doesn't lie.
  const knownNames = new Set(byConnector.map((b) => b.source));
  for (const r of ingestRows) {
    if (!knownNames.has(r.source_name)) {
      const cursor = cursorByConnector.get(r.source_name);
      byConnector.push({
        source: r.source_name,
        ingested: Number(r.n),
        lastError: cursor?.lastError ?? null,
        lastErrorAt: cursor?.lastErrorAt ?? null,
        lastRunAt: cursor?.lastRunAt ?? null,
      });
    }
  }

  // Per-host stats over the window. Pull source_url + flags, group in
  // memory by extracted host (regexp-based grouping in Postgres is
  // fragile compared to the JS URL parser the rest of the pipeline
  // uses).
  const rows = await db
    .selectFrom("story")
    .select([
      "source_url",
      "passed_gate",
      "published_to_reader",
    ])
    .where("ingested_at", ">=", since)
    .where("source_url", "is not", null)
    .execute();

  const stats = new Map<
    string,
    { ingested: number; passed: number; published: number }
  >();
  for (const r of rows) {
    const host = extractHost(r.source_url);
    if (host === null) continue;
    const e =
      stats.get(host) ?? { ingested: 0, passed: 0, published: 0 };
    e.ingested++;
    if (r.passed_gate) e.passed++;
    if (r.published_to_reader) e.published++;
    stats.set(host, e);
  }

  // For each host, decide whether it's directly blocked, blocked by a
  // parent (subdomain rollup), or clean. Mirrors the runtime check in
  // src/shared/source-blocklist.ts.
  const findParentBlock = (host: string): string | null => {
    const labels = host.split(".");
    for (let i = 1; i < labels.length - 1; i++) {
      const parent = labels.slice(i).join(".");
      if (blockedSet.has(parent)) return parent;
    }
    return null;
  };

  const hosts = [...stats.entries()].map(([host, s]) => {
    const isBlocked = blockedSet.has(host);
    const blockedByParent = isBlocked ? null : findParentBlock(host);
    return {
      host,
      ingested: s.ingested,
      passed: s.passed,
      published: s.published,
      passRate: s.ingested > 0 ? s.passed / s.ingested : 0,
      isBlocked,
      blockedByParent,
    };
  });

  const sortFn = (
    a: (typeof hosts)[number],
    b: (typeof hosts)[number],
  ): number => {
    let cmp: number;
    switch (sort) {
      case "host":
        cmp = a.host.localeCompare(b.host);
        break;
      case "ingested":
        cmp = a.ingested - b.ingested;
        break;
      case "passed":
        cmp = a.passed - b.passed;
        break;
      case "passRate":
        cmp = a.passRate - b.passRate;
        break;
      case "published":
        cmp = a.published - b.published;
        break;
    }
    if (cmp === 0) cmp = b.ingested - a.ingested; // tiebreak by volume
    return dir === "asc" ? cmp : -cmp;
  };
  hosts.sort(sortFn);

  const flash =
    q.blocked !== undefined
      ? ({ kind: "ok", msg: `Blocked ${q.blocked}.` } as const)
      : q.blocked_n !== undefined
        ? ({ kind: "ok", msg: `Blocked ${q.blocked_n} hosts.` } as const)
        : q.unblocked !== undefined
          ? ({ kind: "ok", msg: `Unblocked ${q.unblocked}.` } as const)
          : q.error === "empty_host"
            ? ({ kind: "err", msg: "Host can't be empty." } as const)
            : q.error === "bad_host"
              ? ({ kind: "err", msg: "That doesn't look like a host." } as const)
              : null;

  return {
    windowDays,
    sort,
    dir,
    blocklist: blocklistRows.map((r) => ({
      host: r.host,
      reason: r.reason,
      blockedAt: r.blocked_at,
    })),
    byConnector,
    hosts: hosts.map(({ passRate: _passRate, ...h }) => h),
    flash,
  };
}

export async function loadThemesData(
  filter: ThemeFilter,
  flash: ThemesData["flash"],
): Promise<ThemesData> {
  const totalRow = await db
    .selectFrom("theme")
    .select(sql<string>`count(*)`.as("n"))
    .executeTakeFirstOrThrow();

  // n_stories = current member count (live, not the denormalized
  // n_stories_published counter). cohesion = avg cosine of member
  // embeddings to centroid, NULL when fewer than 2 embedded members.
  // Both subqueries are correlated and reasonably cheap (story.theme_id
  // is indexed; pgvector cosine is constant-time per row).
  let q = db
    .selectFrom("theme")
    .leftJoin("category", "category.id", "theme.category_id")
    .select([
      "theme.id",
      "theme.name",
      "category.slug as category_slug",
      "theme.first_seen_at",
      "theme.last_published_at",
      "theme.n_stories_published",
      "theme.rolling_composite_avg",
      "theme.rolling_composite_30d",
      "theme.is_long_running",
      sql<string>`(SELECT count(*)::text FROM story s WHERE s.theme_id = theme.id)`.as(
        "n_stories",
      ),
      sql<string | null>`(
        SELECT
          CASE WHEN count(*) >= 2
            THEN AVG(1 - (s.embedding <=> theme.centroid_embedding))::text
            ELSE NULL
          END
        FROM story s
        WHERE s.theme_id = theme.id
          AND s.embedding IS NOT NULL
          AND theme.centroid_embedding IS NOT NULL
      )`.as("cohesion"),
    ]);

  if (filter === "long_running") {
    q = q.where("theme.is_long_running", "=", true);
  }
  if (filter === "active") {
    const since = new Date(Date.now() - 30 * 24 * 3600_000);
    q = q.where("theme.last_published_at", ">=", since);
  }

  const rows = await q.orderBy("theme.last_published_at", "desc").limit(500).execute();

  // Trajectory is computed in-memory (same formula as loadThemeMeta in
  // compose.ts). Could be shared if we refactor, but themes page is
  // read-only and the math is trivial.
  let mapped: ThemeRow[] = rows.map((r) => {
    const avg =
      r.rolling_composite_avg !== null ? Number(r.rolling_composite_avg) : null;
    const d30 =
      r.rolling_composite_30d !== null ? Number(r.rolling_composite_30d) : null;
    const n = r.n_stories_published;
    let trajectory: ThemeRow["trajectory"];
    if (n < 3 || avg === null || d30 === null) trajectory = "new";
    else if (avg === 0) trajectory = "stable";
    else {
      const ratio = d30 / avg;
      if (ratio > 1.1) trajectory = "rising";
      else if (ratio < 0.9) trajectory = "falling";
      else trajectory = "stable";
    }
    return {
      id: Number(r.id),
      name: r.name,
      category: r.category_slug,
      firstSeenAt: r.first_seen_at,
      lastPublishedAt: r.last_published_at,
      nStoriesPublished: r.n_stories_published,
      nStories: Number(r.n_stories),
      cohesion: r.cohesion !== null ? Number(r.cohesion) : null,
      rollingAvg: avg,
      rolling30d: d30,
      trajectory,
      isLongRunning: r.is_long_running,
    };
  });

  if (filter === "rising") {
    mapped = mapped.filter((t) => t.trajectory === "rising");
  }

  return {
    rows: mapped,
    filter,
    total: Number(totalRow.n),
    flash,
  };
}

export async function loadThemeDetail(id: number): Promise<ThemeDetailData | null> {
  const themeRow = await db
    .selectFrom("theme")
    .leftJoin("category", "category.id", "theme.category_id")
    .select([
      "theme.id",
      "theme.name",
      "category.slug as category_slug",
      "theme.first_seen_at",
      "theme.last_published_at",
      "theme.n_stories_published",
      "theme.rolling_composite_avg",
      "theme.rolling_composite_30d",
      "theme.is_long_running",
      sql<boolean>`(theme.centroid_embedding IS NOT NULL)`.as("has_centroid"),
      sql<string>`(SELECT count(*)::text FROM story s WHERE s.theme_id = theme.id)`.as(
        "n_stories",
      ),
      sql<string | null>`(
        SELECT
          CASE WHEN count(*) >= 2
            THEN AVG(1 - (s.embedding <=> theme.centroid_embedding))::text
            ELSE NULL
          END
        FROM story s
        WHERE s.theme_id = theme.id
          AND s.embedding IS NOT NULL
          AND theme.centroid_embedding IS NOT NULL
      )`.as("cohesion"),
    ])
    .where("theme.id", "=", id)
    .executeTakeFirst();
  if (!themeRow) return null;

  // Pull every member story with its cosine to the centroid. Order by
  // cosine ascending so outliers (potential mis-attaches) bubble up.
  // Stories without an embedding are kept (cosine = NULL) so the table
  // is complete; they sort to the end.
  const memberRows = await db
    .selectFrom("story")
    .select([
      "story.id",
      "story.title",
      "story.composite",
      "story.passed_gate",
      "story.published_to_reader",
      "story.published_at",
      "story.ingested_at",
      "story.source_url",
      sql<string | null>`
        CASE
          WHEN story.embedding IS NOT NULL
            AND (SELECT centroid_embedding FROM theme WHERE id = ${id}) IS NOT NULL
          THEN (1 - (story.embedding <=> (SELECT centroid_embedding FROM theme WHERE id = ${id})))::text
          ELSE NULL
        END
      `.as("cosine"),
    ])
    .where("story.theme_id", "=", id)
    .orderBy(sql`cosine ASC NULLS LAST`)
    .limit(500)
    .execute();

  const members: ThemeMember[] = memberRows.map((r) => ({
    id: Number(r.id),
    title: r.title,
    cosine: r.cosine !== null ? Number(r.cosine) : null,
    composite: r.composite !== null ? Number(r.composite) : null,
    passedGate: r.passed_gate,
    publishedToReader: r.published_to_reader,
    publishedAt: r.published_at,
    ingestedAt: r.ingested_at,
    sourceDomain: domainOfUrl(r.source_url),
  }));

  return {
    theme: {
      id: Number(themeRow.id),
      name: themeRow.name,
      category: themeRow.category_slug,
      firstSeenAt: themeRow.first_seen_at,
      lastPublishedAt: themeRow.last_published_at,
      nStories: Number(themeRow.n_stories),
      nStoriesPublished: themeRow.n_stories_published,
      cohesion:
        themeRow.cohesion !== null ? Number(themeRow.cohesion) : null,
      rollingAvg:
        themeRow.rolling_composite_avg !== null
          ? Number(themeRow.rolling_composite_avg)
          : null,
      rolling30d:
        themeRow.rolling_composite_30d !== null
          ? Number(themeRow.rolling_composite_30d)
          : null,
      isLongRunning: themeRow.is_long_running,
      hasCentroid: themeRow.has_centroid,
    },
    members,
  };
}

export async function loadEditorSandboxData(): Promise<EditorSandboxData> {
  // Same window as compose.ts (14 days). If this drifts, both should
  // move together — keep in sync if you ever extract.
  const cutoffMs = Date.now() - 14 * 24 * 3600_000;
  const cutoff = new Date(cutoffMs);

  const cfgRows = await db
    .selectFrom("config")
    .select(["key", "value"])
    .where("key", "in", [
      "editor.pool_max_themes",
      "editor.pool_max_category_fraction",
    ])
    .execute();
  const cfgMap = new Map(cfgRows.map((r) => [r.key, r.value]));
  const maxThemes =
    typeof cfgMap.get("editor.pool_max_themes") === "number"
      ? (cfgMap.get("editor.pool_max_themes") as number)
      : 20;
  const maxCategoryFraction =
    typeof cfgMap.get("editor.pool_max_category_fraction") === "number"
      ? (cfgMap.get("editor.pool_max_category_fraction") as number)
      : 1.0;

  const rows = await db
    .selectFrom("story")
    .leftJoin("theme", "theme.id", "story.theme_id")
    .leftJoin("category", "category.id", "story.category_id")
    .select([
      "story.id as story_id",
      "story.title",
      "story.composite",
      "story.point_in_time_confidence",
      "story.theme_id",
      "story.source_url",
      "story.additional_source_urls",
      "theme.name as theme_name",
      "category.slug as category_slug",
    ])
    .where("story.passed_gate", "=", true)
    .where("story.published_to_reader", "=", false)
    .where("story.ingested_at", ">=", cutoff)
    // Mirror compose.ts: Wikipedia is signal, not a pickable story.
    .where("story.source_name", "!=", "wikipedia")
    .orderBy("story.composite", "desc")
    .execute();

  const result = selectEditorPool(rows, maxThemes, { maxCategoryFraction });

  // Wikipedia corroboration set: themes that have a Wikipedia member
  // anywhere in the database (Wikipedia stories were filtered out of
  // `rows` above; this query reaches past the pool to find them).
  const allBucketThemeIds = [
    ...result.included,
    ...result.excluded,
  ]
    .map((b) => b.themeId)
    .filter((id): id is number => id !== null);
  const wikipediaCorroborated = new Set<number>();
  if (allBucketThemeIds.length > 0) {
    const wikiRows = await db
      .selectFrom("story")
      .select("theme_id")
      .distinct()
      .where("theme_id", "in", allBucketThemeIds)
      .where("source_name", "=", "wikipedia")
      .execute();
    for (const r of wikiRows) {
      if (r.theme_id !== null) wikipediaCorroborated.add(Number(r.theme_id));
    }
  }

  // Per-category passer + in-pool counts. The "in pool" count comes
  // from the selected buckets; "passers" from the full row set. Lets
  // the operator see at a glance which categories are over/under-
  // represented in the pool relative to their gate-pass volume.
  const inPoolRowIds = new Set<number>();
  for (const b of result.included) {
    for (const e of b.rows) inPoolRowIds.add(Number(e.row.story_id));
  }
  const catCounts = new Map<string, { passers: number; inPool: number }>();
  for (const r of rows) {
    const key = r.category_slug ?? "—";
    const e = catCounts.get(key) ?? { passers: 0, inPool: 0 };
    e.passers++;
    if (inPoolRowIds.has(Number(r.story_id))) e.inPool++;
    catCounts.set(key, e);
  }
  const byCategory = [...catCounts.entries()]
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.passers - a.passers);

  const toBucket = (
    b: (typeof result.included)[number],
  ): SandboxBucket => {
    const first = b.rows[0]?.row;
    const themeName =
      b.themeId !== null
        ? (first?.theme_name ?? `theme #${b.themeId}`)
        : null;
    return {
      themeId: b.themeId,
      themeName,
      category: first?.category_slug ?? null,
      storyCount: b.rows.length,
      maxComposite: b.maxComposite,
      tier1Total: b.tier1Total,
      wikipediaCorroborated:
        b.themeId !== null && wikipediaCorroborated.has(b.themeId),
      stories: b.rows.map((e) => ({
        id: Number(e.row.story_id),
        title: e.row.title,
        composite:
          e.row.composite !== null ? Number(e.row.composite) : null,
        confidence: e.row.point_in_time_confidence,
        sourceUrl: e.row.source_url,
        tier1Sources: e.tier1,
        totalSources: e.total,
      })),
    };
  };

  return {
    maxThemes,
    ingestWindowDays: 14,
    totalPassers: result.totalPassers,
    totalThemes: result.totalThemes,
    poolStories: result.pool.length,
    included: result.included.map(toBucket),
    excluded: result.excluded.map(toBucket),
    byCategory,
  };
}

export async function loadThemeGraphData(filters: {
  minCosine: number;
  category: string | null;
  hideSingletons: boolean;
}): Promise<ThemeGraphData> {
  // Fetch every theme (member count + cohesion). Filter by category
  // and singletons in JS so the dataset is consistent across the
  // edge query (which doesn't know about either filter).
  const themesQ = await db
    .selectFrom("theme")
    .leftJoin("category", "category.id", "theme.category_id")
    .select([
      "theme.id",
      "theme.name",
      "category.slug as category_slug",
      sql<string>`(SELECT count(*)::text FROM story s WHERE s.theme_id = theme.id)`.as(
        "n_stories",
      ),
      sql<string | null>`(
        SELECT
          CASE WHEN count(*) >= 2
            THEN AVG(1 - (s.embedding <=> theme.centroid_embedding))::text
            ELSE NULL
          END
        FROM story s
        WHERE s.theme_id = theme.id
          AND s.embedding IS NOT NULL
          AND theme.centroid_embedding IS NOT NULL
      )`.as("cohesion"),
    ])
    .where("theme.centroid_embedding", "is not", null)
    .execute();

  let nodes: GraphNode[] = themesQ.map((r) => ({
    id: Number(r.id),
    name: r.name,
    category: r.category_slug,
    n_stories: Number(r.n_stories),
    cohesion: r.cohesion !== null ? Number(r.cohesion) : null,
  }));
  if (filters.category !== null) {
    nodes = nodes.filter((n) => n.category === filters.category);
  }
  if (filters.hideSingletons) {
    nodes = nodes.filter((n) => n.n_stories >= 2);
  }
  const visibleIds = new Set(nodes.map((n) => n.id));

  // For each visible theme, find top-K nearest other themes via
  // lateral join. K=5 keeps the visible graph manageable; the cosine
  // threshold further trims. After the embedding upgrade every theme
  // has many close neighbors, so K can be small without losing
  // signal — the strongest connections survive.
  const minCos = filters.minCosine;
  const edgeRows = await db.executeQuery(
    sql<{ a_id: number; b_id: number; cosine: string }>`
      SELECT a.id::int AS a_id, nbr.id::int AS b_id, nbr.cos::text AS cosine
      FROM theme a
      CROSS JOIN LATERAL (
        SELECT b.id, 1 - (a.centroid_embedding <=> b.centroid_embedding) AS cos
        FROM theme b
        WHERE b.id <> a.id
          AND b.centroid_embedding IS NOT NULL
        ORDER BY a.centroid_embedding <=> b.centroid_embedding
        LIMIT 5
      ) nbr
      WHERE a.centroid_embedding IS NOT NULL
        AND nbr.cos >= ${minCos}
    `.compile(db),
  );

  // Dedupe undirected edges (a→b and b→a are the same connection).
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const r of edgeRows.rows) {
    const a = Math.min(r.a_id, r.b_id);
    const b = Math.max(r.a_id, r.b_id);
    if (!visibleIds.has(a) || !visibleIds.has(b)) continue;
    const key = `${a}-${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ a, b, cosine: Number(r.cosine) });
  }

  // Categories present in the data — drives the category filter
  // dropdown. Keep alphabetical for predictable order.
  const categories = Array.from(
    new Set(
      themesQ
        .map((r) => r.category_slug)
        .filter((c): c is string => c !== null),
    ),
  ).sort();

  return {
    nodes,
    edges,
    filters,
    totals: { themes: nodes.length, edges: edges.length },
    categories,
  };
}

export function domainOfUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export async function loadConfigRows(): Promise<ConfigRow[]> {
  const rows = await db
    .selectFrom("config")
    .select(["key", "value", "updated_at"])
    .orderBy("key", "asc")
    .execute();
  return rows.map((r) => ({
    key: r.key,
    value: r.value,
    updatedAt: r.updated_at,
  }));
}

export function parseConfigFlash(
  saved: string | undefined,
  error: string | undefined,
  key: string | undefined,
): { kind: "ok" | "error"; msg: string; key: string | null } | null {
  const k = key !== undefined && key.length > 0 ? key : null;
  const label = k !== null ? ` (${k})` : "";
  if (saved) return { kind: "ok", msg: `Saved${label}.`, key: k };
  if (error === "bad_json") {
    return { kind: "error", msg: `Value is not valid JSON${label}.`, key: k };
  }
  if (error === "unknown_key") {
    return { kind: "error", msg: `Unknown config key${label}.`, key: k };
  }
  if (error === "missing_key") {
    return { kind: "error", msg: "Missing key in form submission.", key: null };
  }
  return null;
}

export async function loadTheme(id: number): Promise<ThemeViewData | null> {
  const theme = await db
    .selectFrom("theme")
    .leftJoin("category", "category.id", "theme.category_id")
    .select([
      "theme.id",
      "theme.name",
      "theme.description",
      "theme.first_seen_at",
      "theme.n_stories_published",
      "category.slug as category_slug",
    ])
    .where("theme.id", "=", id)
    .executeTakeFirst();
  if (!theme) return null;

  const stories = await db
    .selectFrom("story")
    .select([
      "id",
      "title",
      "published_at",
      "published_to_reader",
      "source_url",
      "scorer_summary",
    ])
    .where("theme_id", "=", id)
    .where((eb) =>
      eb.or([
        eb("passed_gate", "=", true),
        eb("published_to_reader", "=", true),
      ]),
    )
    .orderBy("published_at", "desc")
    .limit(100)
    .execute();

  // Resolve issue_id per story via issue.story_ids. Cheap full-scan:
  // weekly cadence puts an upper bound around ~50 issues/year, so we
  // skip the ANY/&& array indexing dance for now.
  const storyIdSet = new Set(stories.map((s) => Number(s.id)));
  const issueOf = new Map<number, { id: number; seq: number | null }>();
  if (storyIdSet.size > 0) {
    const issueRows = await db
      .selectFrom("issue")
      .select(["id", "published_seq", "story_ids"])
      .where("is_draft", "=", false)
      .orderBy("published_at", "desc")
      .execute();
    for (const iss of issueRows) {
      for (const sid of iss.story_ids ?? []) {
        const n = Number(sid);
        if (storyIdSet.has(n) && !issueOf.has(n)) {
          issueOf.set(n, { id: Number(iss.id), seq: iss.published_seq });
        }
      }
    }
  }

  return {
    id: Number(theme.id),
    name: theme.name,
    description: theme.description,
    category: theme.category_slug,
    firstSeenAt: theme.first_seen_at,
    nStoriesPublished: theme.n_stories_published,
    stories: stories.map((s) => {
      const issue = issueOf.get(Number(s.id));
      return {
        id: Number(s.id),
        title: s.title,
        publishedAt: s.published_at,
        publishedToReader: s.published_to_reader,
        sourceUrl: s.source_url,
        oneLiner: s.scorer_summary ?? "",
        issueId: issue?.id ?? null,
        issueSeq: issue?.seq ?? null,
      };
    }),
  };
}

// Used both by the full review-page loader (loadReview) and by the
// HTMX annotate/delete handlers that re-render just the list fragment.
export async function loadAnnotations(issueId: number): Promise<Annotation[]> {
  const rows = await db
    .selectFrom("issue_annotation")
    .select(["id", "slot", "body", "anchor_key", "reviewer_name", "created_at"])
    .where("issue_id", "=", issueId)
    .orderBy("created_at", "desc")
    .execute();
  return rows.map((r) => ({
    id: Number(r.id),
    slot: r.slot,
    body: r.body,
    anchorKey: r.anchor_key,
    reviewerName: r.reviewer_name,
    createdAt: r.created_at,
  }));
}

// Look up the issue's composedHtml just to extract anchor snippets.
// HTMX annotate/delete responses re-render the sidebar fragment, which
// needs the snippet labels to keep group headings in sync.
export async function loadIssueSnippets(
  issueId: number,
): Promise<Array<{ key: string; text: string }>> {
  const row = await db
    .selectFrom("issue")
    .select("composed_html")
    .where("id", "=", issueId)
    .executeTakeFirst();
  if (!row) return [];
  return decorateBriefHtml(row.composed_html).snippets;
}

export async function loadReview(id: number): Promise<EditorReviewData | null> {
  const iss = await db
    .selectFrom("issue")
    .select([
      "id",
      "published_seq",
      "published_at",
      "is_event_driven",
      "is_draft",
      "composer_prompt_version",
      "composer_model_id",
      "story_ids",
      "composed_html",
      "composed_markdown",
      "title",
      "editor_output_jsonb",
      "shrug_candidates_jsonb",
    ])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!iss) return null;

  const storyIds = iss.story_ids ?? [];
  const titleRows = storyIds.length
    ? await db
        .selectFrom("story")
        .leftJoin("theme", "theme.id", "story.theme_id")
        .select([
          "story.id",
          "story.title",
          "story.theme_id",
          "theme.name as theme_name",
        ])
        .where("story.id", "in", storyIds)
        .execute()
    : [];
  const storyTitles = new Map<number, string>(
    titleRows.map((r) => [Number(r.id), r.title]),
  );
  const storyThemes = new Map<
    number,
    { theme_id: number | null; theme_name: string | null }
  >(
    titleRows.map((r) => [
      Number(r.id),
      {
        theme_id: r.theme_id !== null ? Number(r.theme_id) : null,
        theme_name: r.theme_name,
      },
    ]),
  );

  const annotations = await db
    .selectFrom("issue_annotation")
    .select(["id", "slot", "body", "anchor_key", "reviewer_name", "created_at"])
    .where("issue_id", "=", id)
    .orderBy("created_at", "desc")
    .execute();

  // Re-run the gloss-linter for the advisory panel. Read-only: the
  // compose stage already bumped gloss_term hit counts when the draft
  // was produced; here we only render the current findings.
  const glossTerms = await loadGlossTerms();
  const glossFindings = lintGloss(iss.composed_markdown, glossTerms);

  return {
    issue: {
      id: Number(iss.id),
      publishedSeq: iss.published_seq,
      publishedAt: iss.published_at,
      isEventDriven: iss.is_event_driven,
      isDraft: iss.is_draft,
      composerPromptVersion: iss.composer_prompt_version,
      composerModelId: iss.composer_model_id,
      composedHtml: iss.composed_html,
      composedMarkdown: iss.composed_markdown,
      title: iss.title,
    },
    annotations: annotations.map((a) => ({
      id: Number(a.id),
      slot: a.slot,
      body: a.body,
      anchorKey: a.anchor_key,
      reviewerName: a.reviewer_name,
      createdAt: a.created_at,
    })),
    editor: iss.editor_output_jsonb as EditorReviewData["editor"],
    storyTitles,
    storyThemes,
    shrug: (iss.shrug_candidates_jsonb as EditorReviewData["shrug"]) ?? [],
    glossFindings,
  };
}

// Scan fixtures/ for composer-replay-i<N>-<stamp>.html files, group
// their base names by issue id. One pass covers every issue.
export async function loadReplaysByIssue(): Promise<Map<number, Array<{ base: string; mtime: Date }>>> {
  const dir = resolve("fixtures");
  const names = await readdir(dir).catch(() => [] as string[]);
  const out = new Map<number, Array<{ base: string; mtime: Date }>>();
  for (const name of names) {
    if (!name.startsWith("composer-replay-i")) continue;
    if (!name.endsWith(".html")) continue;
    const m = /^composer-replay-i(\d+)-(.+)\.html$/.exec(name);
    if (!m || m[1] === undefined) continue;
    const issueId = Number(m[1]);
    const st = await stat(resolve(dir, name)).catch(() => null);
    if (st === null) continue;
    const base = name.slice(0, -".html".length);
    const list = out.get(issueId) ?? [];
    list.push({ base, mtime: st.mtime });
    out.set(issueId, list);
  }
  for (const list of out.values()) {
    list.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  }
  return out;
}

export async function loadManageData(
  subscriptionId: number,
  token: string,
  flash: ManageData["flash"],
): Promise<ManageData | null> {
  const sub = await db
    .selectFrom("email_subscription")
    .select([
      "email",
      "delivery_time_local",
      "timezone",
      "urgent_override",
      "category_mutes",
    ])
    .where("id", "=", subscriptionId)
    .executeTakeFirst();
  if (sub === undefined) return null;
  const cats = await db
    .selectFrom("category")
    .select(["slug", "name"])
    .orderBy("name", "asc")
    .execute();
  return {
    token,
    email: sub.email,
    deliveryTimeLocal: sub.delivery_time_local,
    timezone: sub.timezone,
    urgentOverride: sub.urgent_override,
    categoryMutes: sub.category_mutes,
    categories: cats as ManageCategory[],
    flash,
  };
}

export function parseManageFlash(
  saved: string | undefined,
  error: string | undefined,
): ManageData["flash"] {
  if (saved) return { kind: "ok", msg: "Preferences saved." };
  if (error === "bad_time") {
    return { kind: "error", msg: "Delivery time must be in HH:MM format." };
  }
  if (error === "bad_tz") {
    return {
      kind: "error",
      msg: "That timezone isn't one we recognize. Use an IANA name like Europe/Oslo.",
    };
  }
  return null;
}

// IANA timezone check. Intl.DateTimeFormat throws on unknown names;
// the success path is the validation. No external tz table required.
export function isValidTimezone(tz: string): boolean {
  if (tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function loadReplaysForIssue(
  issueId: number,
): Promise<Array<{ base: string; mtime: Date }>> {
  const all = await loadReplaysByIssue();
  return all.get(issueId) ?? [];
}

// Editor replays are named editor-replay-i<N>-<stamp>.diff.md (and .json).
// We key on the .diff.md since that's what the admin review page links to.
export async function loadEditorReplaysForIssue(
  issueId: number,
): Promise<Array<{ base: string; mtime: Date }>> {
  const dir = resolve("fixtures");
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: Array<{ base: string; mtime: Date }> = [];
  for (const name of names) {
    if (!name.startsWith(`editor-replay-i${issueId}-`)) continue;
    if (!name.endsWith(".diff.md")) continue;
    const st = await stat(resolve(dir, name)).catch(() => null);
    if (st === null) continue;
    const base = name.slice(0, -".diff.md".length);
    out.push({ base, mtime: st.mtime });
  }
  out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return out;
}

export async function loadAdminIssues(): Promise<AdminIssueRow[]> {
  const rows = await db
    .selectFrom("issue")
    .select([
      "id",
      "published_at",
      "is_event_driven",
      "is_draft",
      "composer_prompt_version",
      "composer_model_id",
      "story_ids",
    ])
    .orderBy("is_draft", "desc")
    .orderBy("published_at", "desc")
    .execute();
  const replays = await loadReplaysByIssue();
  return rows.map((r) => ({
    id: Number(r.id),
    publishedAt: r.published_at,
    isEventDriven: r.is_event_driven,
    isDraft: r.is_draft,
    composerPromptVersion: r.composer_prompt_version,
    composerModelId: r.composer_model_id,
    storyCount: (r.story_ids ?? []).length,
    replays: replays.get(Number(r.id)) ?? [],
  }));
}

export async function loadArchive(): Promise<ArchiveEntry[]> {
  const rows = await db
    .selectFrom("issue")
    .select(["id", "published_seq", "published_at", "is_event_driven", "title"])
    .where("is_draft", "=", false)
    .orderBy("published_at", "desc")
    .execute();
  return rows.map((r) => ({
    id: Number(r.id),
    publishedSeq: r.published_seq,
    publishedAt: r.published_at,
    isEventDriven: r.is_event_driven,
    title: r.title,
  }));
}

export function parseFlash(
  subscribed: string | undefined,
  error: string | undefined,
  already?: string | undefined,
): Flash {
  if (subscribed && already) {
    return {
      kind: "ok",
      msg: "Already confirmed. You'll hear from Blurp when there's something worth reading.",
    };
  }
  if (subscribed) {
    return {
      kind: "ok",
      msg: "Check your inbox for a confirmation link. You're not on the list until you click it.",
    };
  }
  if (error === "invalid_email") {
    return { kind: "error", msg: "That email didn't parse. Try again." };
  }
  if (error === "rate_limited") {
    return {
      kind: "error",
      msg: "Too many attempts. Give it a minute and try again.",
    };
  }
  return null;
}

export async function loadPromptEditor(
  stage: PromptStageKey,
  query: Record<string, string>,
): Promise<PromptEditorData> {
  const filePath = `docs/${stage}-prompt.md`;
  const loaded = await loadRawPrompt(stage, filePath, "replay");
  const staged =
    loaded.source === "staged"
      ? await db
          .selectFrom("prompt_draft")
          .select(["updated_at"])
          .where("stage", "=", stage)
          .executeTakeFirst()
      : undefined;
  const cfgRow = await db
    .selectFrom("config")
    .select("value")
    .where("key", "=", `${stage}.prompt_version`)
    .executeTakeFirst();
  const liveVersion =
    cfgRow !== undefined ? String(cfgRow.value).replace(/^"|"$/g, "") : null;
  const flash = parsePromptFlash(query);
  return {
    stage,
    promptText: loaded.raw,
    source: loaded.source,
    stagedUpdatedAt: staged?.updated_at ?? null,
    liveVersion,
    flash,
  };
}

export function parsePromptFlash(
  q: Record<string, string>,
): { kind: "ok"; msg: string } | { kind: "err"; msg: string } | null {
  if (q.saved === "1") return { kind: "ok", msg: "Staged." };
  if (q.cleared === "1")
    return { kind: "ok", msg: "Staged prompt cleared — falls back to file." };
  if (q.error === "empty") return { kind: "err", msg: "Prompt is empty." };
  return null;
}

export function parseReviewFlash(
  q: Record<string, string>,
): { kind: "ok"; msg: string } | { kind: "err"; msg: string } | null {
  if (q.published === "1") return { kind: "ok", msg: "Published." };
  if (q.recomposed === "1")
    return { kind: "ok", msg: "Re-composed. Review below." };
  if (q.reedited === "1")
    return { kind: "ok", msg: "Re-edited — new picks + prose." };
  if (q.error === "not_draft")
    return { kind: "err", msg: "Not a draft — already published." };
  if (q.error === "missing_input")
    return {
      kind: "err",
      msg: "No composer input persisted on this draft — try Re-edit instead.",
    };
  if (q.error === "no_pool")
    return {
      kind: "err",
      msg: "Pool is empty — no passing stories to re-edit from.",
    };
  if (q.error === "recompose_failed")
    return { kind: "err", msg: "Re-compose failed — check logs." };
  if (q.error === "reedit_failed")
    return { kind: "err", msg: "Re-edit failed — check logs." };
  if (q.error === "empty_note")
    return { kind: "err", msg: "Note body can't be empty." };
  if (q.noted === "1") return { kind: "ok", msg: "Note added." };
  if (q.deleted_note === "1") return { kind: "ok", msg: "Note deleted." };
  if (q.edited === "1") return { kind: "ok", msg: "Draft edits saved." };
  if (q.error === "empty_edit")
    return {
      kind: "err",
      msg: "Title and HTML body can't be empty.",
    };
  if (q.replayed === "1")
    return {
      kind: "ok",
      msg: "Composer replay complete — see 'Latest replay' below.",
    };
  if (q.error === "replay_failed")
    return { kind: "err", msg: "Replay failed — check server logs." };
  if (q.replay_replaced === "1")
    return {
      kind: "ok",
      msg: "Issue rewritten in place with the current prompt. The reader sees the new version on the next page load.",
    };
  if (q.error === "replay_replace_failed")
    return { kind: "err", msg: "Replay-and-replace failed — check server logs. The issue is unchanged." };
  if (q.error === "not_found")
    return { kind: "err", msg: "Issue not found." };
  if (q.error === "missing_input")
    return {
      kind: "err",
      msg: "This issue predates the composer_input_jsonb persistence (migration 015) — no replay possible.",
    };
  if (q.shared === "1")
    return { kind: "ok", msg: "Preview link generated below — copy and send it." };
  if (q.error === "empty_reviewer")
    return { kind: "err", msg: "Reviewer name can't be empty." };
  if (q.error === "not_draft_share")
    return { kind: "err", msg: "Preview links are only for drafts." };
  return null;
}
