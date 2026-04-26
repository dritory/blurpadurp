// Hono app: public archive, subscription endpoints, preference pages.
// No accounts — subscription is the identity. All routes are public.

import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { serveStatic } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import { sql } from "kysely";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

import { db } from "../db/index.ts";
import {
  discardDraft,
  publishDraft,
  recomposeDraft,
  reeditDraft,
} from "../pipeline/draft.ts";
import type {
  CapturedRow,
  ReplayRow,
} from "../pipeline/fixture.ts";
import { summarizeReplay } from "../pipeline/fixture.ts";
import { loadPipelineStatus } from "./status.ts";
import { AdminStatus } from "../views/admin-status.tsx";
import { getEnvOptional } from "../shared/env.ts";
import { sendMail } from "../shared/mailer.ts";
import { clientIp, makeRateLimiter } from "../shared/rate-limit.ts";
import { loadRawPrompt } from "../shared/prompts.ts";
import { extractHost, normalizeHost } from "../shared/source-blocklist.ts";
import { securityHeaders } from "../shared/security-headers.ts";
import { verifySvixSignature } from "../shared/svix.ts";
import { signToken, verifyToken } from "../shared/tokens.ts";
import { About } from "../views/about.tsx";
import {
  AdminConfig,
  type ConfigRow,
} from "../views/admin-config.tsx";
import {
  AdminCosts,
  type CostDashboardData,
} from "../views/admin-costs.tsx";
import {
  AdminEval,
  type EvalCandidate,
  type EvalStats,
} from "../views/admin-eval.tsx";
import {
  AdminExplore,
  type ExplorerData,
} from "../views/admin-explore.tsx";
import {
  AdminExploreGate,
  type GateSandboxData,
} from "../views/admin-explore-gate.tsx";
import {
  AdminExploreStories,
  type StoriesData,
  type StoryFilter,
  type GateFilter,
  type SortKey,
  type SortDir,
} from "../views/admin-explore-stories.tsx";
import {
  AdminExploreDropped,
  type DroppedData,
  type DroppedFilter,
} from "../views/admin-explore-dropped.tsx";
import {
  AdminExploreBalance,
  type BalanceData,
  type BalanceFilter,
} from "../views/admin-explore-balance.tsx";
import {
  AdminExploreStory,
  type StoryDrilldown,
} from "../views/admin-explore-story.tsx";
import {
  AdminCaptureView,
  AdminFixtureMarkdown,
  AdminFixturesList,
  AdminReplayBrief,
  AdminReplayView,
  type FixtureFile,
} from "../views/admin-fixtures.tsx";
import {
  AdminIssues,
  type AdminIssueRow,
} from "../views/admin-issues.tsx";
import {
  AdminPrompts,
  type PromptEditorData,
  type PromptStageKey,
} from "../views/admin-prompts.tsx";
import {
  AdminReview,
  AnnotationsList,
  decorateBriefHtml,
  type Annotation,
  type EditorReviewData,
} from "../views/admin-review.tsx";
import {
  AdminThemes,
  type ThemeRow,
  type ThemesData,
  type ThemeFilter,
} from "../views/admin-themes.tsx";
import {
  AdminThemeDetail,
  type ThemeDetailData,
  type ThemeMember,
} from "../views/admin-theme-detail.tsx";
import {
  AdminThemeGraph,
  type GraphEdge,
  type GraphNode,
  type ThemeGraphData,
} from "../views/admin-theme-graph.tsx";
import {
  AdminSources,
  type HostSortDir,
  type HostSortKey,
  type SourcesData,
} from "../views/admin-sources.tsx";
import {
  AdminEditorSandbox,
  type EditorSandboxData,
  type SandboxBucket,
} from "../views/admin-editor-sandbox.tsx";
import { selectEditorPool } from "../shared/editor-pool.ts";
import { Archive, type ArchiveEntry } from "../views/archive.tsx";
import { renderConfirmationEmail } from "../views/email.ts";
import {
  ManagePage,
  type Category as ManageCategory,
  type ManageData,
} from "../views/manage.tsx";
import { Privacy } from "../views/privacy.tsx";
import { NotFoundPage, ServerErrorPage } from "../views/error-pages.tsx";
import { renderAtomFeed } from "../views/feed.ts";
import { Home, type Flash } from "../views/home.tsx";
import { IssuePage, type IssueView } from "../views/issue.tsx";
import { SubscribePage } from "../views/subscribe.tsx";
import { ThemePage, type ThemeViewData } from "../views/theme.tsx";
import { TokenResultPage } from "../views/token-result.tsx";

const PUBLIC_URL =
  getEnvOptional("BLURPADURP_PUBLIC_URL") ?? "http://localhost:3000";
const FEED_MAX_ENTRIES = 20;

// 5 attempts burst, refill at 1 per 30s (= 120/hour sustained). Plenty
// for a human; noisy for a script.
const subscribeLimiter = makeRateLimiter({
  capacity: 5,
  refillPerMs: 1 / 30_000,
});

export const app = new Hono();

// Security headers + per-request CSP nonce. Applied globally so admin
// pages benefit too. HSTS off on localhost — turn it on for anything
// with a trusted HTTPS cert.
app.use(
  "*",
  securityHeaders({
    hsts: getEnvOptional("NODE_ENV") === "production",
  }),
);

// Static assets live in ./public — served under /assets/*. Safe to cache
// aggressively; the logo and any supporting files are version-agnostic.
app.use(
  "/assets/*",
  serveStatic({
    root: "./public",
    rewriteRequestPath: (path) => path.replace(/^\/assets\//, "/"),
  }),
);

app.get("/health", async (c) => {
  const s = await loadPipelineStatus();
  const status = s.db_ok ? 200 : 503;
  return c.json(
    {
      ok: s.db_ok,
      last_ingest_at: s.last_ingest_at?.toISOString() ?? null,
      last_ingest_age_sec: s.last_ingest_age_sec,
      last_score_at: s.last_score_at?.toISOString() ?? null,
      last_score_age_sec: s.last_score_age_sec,
      last_issue_at: s.last_issue_at?.toISOString() ?? null,
      last_issue_age_sec: s.last_issue_age_sec,
      unscored_backlog: s.unscored_backlog,
      today_spend_usd: s.today_spend_usd,
      daily_cap_usd: s.daily_cap_usd,
      budget_remaining_usd: s.budget_remaining_usd,
    },
    status,
  );
});

app.get("/", async (c) => {
  const latest = await loadLatestIssue();
  return c.html(<Home latest={latest} flash={null} />);
});

app.get("/subscribe", (c) => {
  const flash = parseFlash(
    c.req.query("subscribed"),
    c.req.query("error"),
    c.req.query("already"),
  );
  return c.html(<SubscribePage flash={flash} />);
});

app.get("/archive", async (c) => {
  const issues = await loadArchive();
  return c.html(<Archive issues={issues} />);
});

app.get("/issue/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) return c.notFound();
  const issue = await loadIssue(id);
  if (issue === null) return c.notFound();
  return c.html(<IssuePage issue={issue} />);
});

app.get("/about", (c) => c.html(<About />));

app.get("/privacy", (c) => c.html(<Privacy />));

app.get("/theme/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) return c.notFound();
  const data = await loadTheme(id);
  if (data === null) return c.notFound();
  return c.html(<ThemePage data={data} />);
});

// --- admin (basic auth via ADMIN_USER / ADMIN_PASSWORD) ---

const adminUser = getEnvOptional("ADMIN_USER") ?? "admin";
const adminPassword = getEnvOptional("ADMIN_PASSWORD");

if (adminPassword !== undefined && adminPassword.length > 0) {
  app.use(
    "/admin/*",
    basicAuth({ username: adminUser, password: adminPassword }),
  );

  app.get("/admin", (c) => c.redirect("/admin/issues", 302));

  app.get("/admin/issues", async (c) => {
    const issues = await loadAdminIssues();
    return c.html(<AdminIssues issues={issues} />);
  });

  app.get("/admin/review/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const data = await loadReview(id);
    if (data === null) return c.notFound();
    const [replays, editorReplays] = await Promise.all([
      loadReplaysForIssue(id),
      loadEditorReplaysForIssue(id),
    ]);
    const flash = parseReviewFlash(c.req.query());
    return c.html(
      <AdminReview
        data={data}
        replays={replays}
        editorReplays={editorReplays}
        flash={flash}
      />,
    );
  });

  app.post("/admin/review/:id/publish", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const ok = await publishDraft(id);
    if (!ok) return c.redirect(`/admin/review/${id}?error=not_draft`, 303);
    return c.redirect(`/admin/review/${id}?published=1`, 303);
  });

  app.post("/admin/review/:id/discard", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const ok = await discardDraft(id);
    if (!ok) return c.redirect(`/admin/review/${id}?error=not_draft`, 303);
    return c.redirect("/admin/issues?discarded=1", 303);
  });

  app.post("/admin/review/:id/recompose", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    try {
      const res = await recomposeDraft(id);
      if (!res.ok)
        return c.redirect(`/admin/review/${id}?error=${res.reason}`, 303);
      return c.redirect(`/admin/review/${id}?recomposed=1`, 303);
    } catch (err) {
      console.error("[recompose]", err);
      return c.redirect(`/admin/review/${id}?error=recompose_failed`, 303);
    }
  });

  app.post("/admin/review/:id/annotate", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const body = await c.req.parseBody();
    // Slot is legacy — the anchor (or its absence) is now the only
    // targeting signal. Hardcode a neutral value so the NOT NULL
    // schema constraint stays satisfied without misleading metadata.
    const slot = "general";
    const text = String(body.body ?? "").trim();
    const rawAnchor = String(body.anchor_key ?? "").trim();
    const anchorKey = rawAnchor.length > 0 ? rawAnchor : null;
    const isHtmx = c.req.header("HX-Request") === "true";
    const renderList = async () => {
      const list = await loadAnnotations(id);
      const snippets = await loadIssueSnippets(id);
      return c.html(
        <AnnotationsList issueId={id} annotations={list} snippets={snippets} />,
      );
    };
    if (text.length === 0) {
      if (isHtmx) return renderList();
      return c.redirect(`/admin/review/${id}?error=empty_note`, 303);
    }
    await db
      .insertInto("issue_annotation")
      .values({ issue_id: id, slot, body: text, anchor_key: anchorKey })
      .execute();
    if (isHtmx) return renderList();
    return c.redirect(`/admin/review/${id}?noted=1#notes`, 303);
  });

  app.post("/admin/review/:id/annotations/:aid/delete", async (c) => {
    const id = Number(c.req.param("id"));
    const aid = Number(c.req.param("aid"));
    if (!Number.isFinite(id) || !Number.isFinite(aid)) return c.notFound();
    await db
      .deleteFrom("issue_annotation")
      .where("id", "=", aid)
      .where("issue_id", "=", id)
      .execute();
    if (c.req.header("HX-Request") === "true") {
      const list = await loadAnnotations(id);
      const snippets = await loadIssueSnippets(id);
      return c.html(
        <AnnotationsList issueId={id} annotations={list} snippets={snippets} />,
      );
    }
    return c.redirect(`/admin/review/${id}?deleted_note=1#notes`, 303);
  });

  app.get("/admin/prompts", async (c) => {
    const stageParam = c.req.query("stage");
    const stage: PromptStageKey =
      stageParam === "editor" ? "editor" : "composer";
    const data = await loadPromptEditor(stage, c.req.query());
    return c.html(<AdminPrompts data={data} />);
  });

  app.post("/admin/prompts/:stage", async (c) => {
    const stageParam = c.req.param("stage");
    const stage: PromptStageKey =
      stageParam === "editor" ? "editor" : "composer";
    const body = await c.req.parseBody();
    const action = String(body.action ?? "save");
    const promptMd = String(body.prompt_md ?? "");

    if (action === "download") {
      return c.body(promptMd, 200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${stage}-prompt.md"`,
      });
    }
    if (action === "clear") {
      await db
        .deleteFrom("prompt_draft")
        .where("stage", "=", stage)
        .execute();
      return c.redirect(`/admin/prompts?stage=${stage}&cleared=1`, 303);
    }
    // save
    if (promptMd.trim().length === 0) {
      return c.redirect(`/admin/prompts?stage=${stage}&error=empty`, 303);
    }
    await db
      .insertInto("prompt_draft")
      .values({ stage, prompt_md: promptMd, updated_at: new Date() })
      .onConflict((oc) =>
        oc.column("stage").doUpdateSet({
          prompt_md: promptMd,
          updated_at: new Date(),
        }),
      )
      .execute();
    return c.redirect(`/admin/prompts?stage=${stage}&saved=1`, 303);
  });

  app.post("/admin/review/:id/reedit", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    try {
      const res = await reeditDraft(id);
      if (!res.ok)
        return c.redirect(`/admin/review/${id}?error=${res.reason}`, 303);
      return c.redirect(`/admin/review/${id}?reedited=1`, 303);
    } catch (err) {
      console.error("[reedit]", err);
      return c.redirect(`/admin/review/${id}?error=reedit_failed`, 303);
    }
  });

  app.get("/admin/status", async (c) => {
    const s = await loadPipelineStatus();
    return c.html(<AdminStatus s={s} />);
  });

  app.get("/admin/costs", async (c) => {
    const data = await loadCostData();
    return c.html(<AdminCosts data={data} />);
  });

  app.get("/admin/explore", async (c) => {
    const data = await loadExplorerData();
    return c.html(<AdminExplore data={data} />);
  });

  app.get("/admin/explore/stories", async (c) => {
    const filter = parseStoryFilter(c.req.query());
    const data = await loadStoriesData(filter);
    return c.html(<AdminExploreStories data={data} />);
  });

  app.get("/admin/explore/story/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const d = await loadStoryDrilldown(id);
    if (d === null) return c.notFound();
    return c.html(<AdminExploreStory d={d} />);
  });

  app.get("/admin/explore/dropped", async (c) => {
    const data = await loadDroppedData(parseDroppedFilter(c.req.query()));
    return c.html(<AdminExploreDropped data={data} />);
  });

  app.get("/admin/explore/balance", async (c) => {
    const data = await loadBalanceData(parseBalanceFilter(c.req.query()));
    return c.html(<AdminExploreBalance data={data} />);
  });

  app.get("/admin/explore/gate", async (c) => {
    const q = c.req.query();
    const lookback = clampInt(q.days, 7, 365, 30);
    const x = clampInt(q.x, 0, 25, -1);
    const cf = (q.cf === "low" || q.cf === "medium" || q.cf === "high")
      ? q.cf
      : null;
    const data = await loadGateSandboxData({
      lookbackDays: lookback,
      xThreshold: x,
      confidenceFloor: cf,
    });
    return c.html(<AdminExploreGate d={data} />);
  });

  app.get("/admin/explore/editor", async (c) => {
    const data = await loadEditorSandboxData();
    return c.html(<AdminEditorSandbox data={data} />);
  });

  app.get("/admin/explore/graph", async (c) => {
    const q = c.req.query();
    // Defaults tuned post-embedding-upgrade. With better cohesion the
    // signal moved up — at the old 0.65 every theme had 10+ neighbors,
    // graph became unreadable. 0.80 keeps only meaningfully-similar
    // pairs. Singletons hidden by default since 735/873 are singletons
    // and they swamp the multi-story themes visually; toggle them on
    // to investigate "did this story attach to anything?" cases.
    const minCosineRaw = Number(q.min_cosine ?? "0.80");
    const minCosine = Number.isFinite(minCosineRaw)
      ? Math.max(0.5, Math.min(0.99, minCosineRaw))
      : 0.80;
    const category = typeof q.category === "string" && q.category !== ""
      ? q.category
      : null;
    // Hide singletons by default. The form uses an inverted checkbox
    // (`show_singletons`) since unchecked HTML checkboxes are omitted
    // from the form payload — there's no clean way to default a
    // `hide_singletons` checkbox to true without a hidden-field hack.
    const hideSingletons = q.show_singletons !== "1";
    const data = await loadThemeGraphData({
      minCosine,
      category,
      hideSingletons,
    });
    return c.html(<AdminThemeGraph data={data} />);
  });

  app.get("/admin/themes", async (c) => {
    const filter = parseThemeFilter(c.req.query("filter"));
    const data = await loadThemesData(
      filter,
      parseFlashGeneric(c.req.query("saved"), c.req.query("error")),
    );
    return c.html(<AdminThemes data={data} />);
  });

  app.get("/admin/themes/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const data = await loadThemeDetail(id);
    if (data === null) return c.notFound();
    return c.html(<AdminThemeDetail data={data} />);
  });

  app.post("/admin/themes/toggle", async (c) => {
    const body = await c.req.parseBody();
    const themeId = Number(body.theme_id);
    const next = body.next === "on";
    const filter = parseThemeFilter(
      typeof body.filter === "string" ? body.filter : undefined,
    );
    if (!Number.isFinite(themeId) || themeId <= 0) {
      return c.redirect(`/admin/themes?filter=${filter}&error=bad_id`, 303);
    }
    await db
      .updateTable("theme")
      .set({ is_long_running: next })
      .where("id", "=", themeId)
      .execute();
    return c.redirect(`/admin/themes?filter=${filter}&saved=1`, 303);
  });

  app.get("/admin/sources", async (c) => {
    const win = Number(c.req.query("window"));
    const windowDays = [7, 14, 30, 60, 90].includes(win) ? win : 30;
    const rawSort = c.req.query("sort");
    const sort: HostSortKey = (
      ["host", "ingested", "passed", "passRate", "published"] as const
    ).includes(rawSort as HostSortKey)
      ? (rawSort as HostSortKey)
      : "ingested";
    const dir: HostSortDir =
      c.req.query("dir") === "asc" ? "asc" : "desc";
    const data = await loadSourcesData(windowDays, sort, dir, c.req.query());
    return c.html(<AdminSources data={data} />);
  });

  app.post("/admin/sources/block", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const reasonRaw = String(body.reason ?? "").trim();
    // Accept body.host as either a single string (typed-in form, "block
    // this source" button) or an array (bulk-block checkboxes from the
    // hosts-seen table). parseBody({all:true}) gives arrays for repeated
    // names; collapse both shapes into a flat list.
    const rawList = Array.isArray(body.host)
      ? body.host.map(String)
      : body.host !== undefined
        ? [String(body.host)]
        : [];
    const trimmed = rawList.map((s) => s.trim()).filter((s) => s.length > 0);
    if (trimmed.length === 0) {
      return c.redirect("/admin/sources?error=empty_host", 303);
    }
    const hosts: string[] = [];
    for (const raw of trimmed) {
      let host: string | null = null;
      try {
        const u = new URL(raw);
        host = normalizeHost(u.hostname);
      } catch {
        host = normalizeHost(raw.replace(/^https?:\/\//, "").split("/")[0]!);
      }
      if (host !== null && host.length > 0 && host.includes(".")) {
        hosts.push(host);
      }
    }
    if (hosts.length === 0) {
      return c.redirect("/admin/sources?error=bad_host", 303);
    }
    const dedup = [...new Set(hosts)];
    await db
      .insertInto("source_blocklist")
      .values(
        dedup.map((host) => ({
          host,
          reason: reasonRaw.length > 0 ? reasonRaw : null,
        })),
      )
      .onConflict((oc) => oc.column("host").doNothing())
      .execute();
    const flashKey = dedup.length === 1 ? "blocked" : "blocked_n";
    const flashVal =
      dedup.length === 1
        ? encodeURIComponent(dedup[0]!)
        : String(dedup.length);
    return c.redirect(
      `/admin/sources?${flashKey}=${flashVal}#hosts-seen`,
      303,
    );
  });

  app.post("/admin/sources/unblock", async (c) => {
    const body = await c.req.parseBody();
    const host = normalizeHost(String(body.host ?? "").trim());
    if (host.length === 0)
      return c.redirect("/admin/sources?error=empty_host", 303);
    await db
      .deleteFrom("source_blocklist")
      .where("host", "=", host)
      .execute();
    return c.redirect(`/admin/sources?unblocked=${encodeURIComponent(host)}`, 303);
  });

  app.get("/admin/eval", async (c) => {
    const stats = await loadEvalStats();
    const candidate = await loadNextEvalCandidate();
    const flash =
      c.req.query("saved") !== undefined ? "Labeled. Next:" : null;
    return c.html(<AdminEval stats={stats} candidate={candidate} flash={flash} />);
  });

  app.post("/admin/eval", async (c) => {
    const body = await c.req.parseBody();
    const storyId = Number(body.story_id);
    const label = String(body.label ?? "");
    const notes =
      typeof body.notes === "string" && body.notes.trim().length > 0
        ? body.notes.trim().slice(0, 400)
        : null;
    if (!Number.isFinite(storyId) || storyId <= 0) {
      return c.redirect("/admin/eval", 303);
    }
    if (!["yes", "maybe", "no", "skip"].includes(label)) {
      return c.redirect("/admin/eval", 303);
    }
    await db
      .insertInto("eval_label")
      .values({
        story_id: storyId,
        label: label as "yes" | "maybe" | "no" | "skip",
        notes,
      })
      .onConflict((oc) =>
        oc.column("story_id").doUpdateSet({
          label: label as "yes" | "maybe" | "no" | "skip",
          notes,
          labeled_at: new Date(),
        }),
      )
      .execute();
    return c.redirect("/admin/eval?saved=1", 303);
  });

  app.get("/admin/config", async (c) => {
    const rows = await loadConfigRows();
    const flash = parseConfigFlash(
      c.req.query("saved"),
      c.req.query("error"),
      c.req.query("key"),
    );
    return c.html(<AdminConfig rows={rows} flash={flash} />);
  });

  app.get("/admin/fixtures", async (c) => {
    const files = await listFixtures();
    return c.html(<AdminFixturesList files={files} />);
  });

  app.get("/admin/fixtures/:name", async (c) => {
    const name = c.req.param("name");
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) return c.notFound();
    const path = resolve("fixtures", name);
    const text = await Bun.file(path).text().catch(() => null);
    if (text === null) return c.notFound();

    const issueIdMatch = /^(?:composer|editor)-replay-i(\d+)-/.exec(name);
    const issueId = issueIdMatch && issueIdMatch[1] !== undefined
      ? Number(issueIdMatch[1])
      : null;

    // Composer-replay HTML: wrap the rendered brief in admin chrome so
    // you can click back to the issue review without losing context.
    if (name.endsWith(".html")) {
      return c.html(
        <AdminReplayBrief name={name} html={text} issueId={issueId} />,
      );
    }

    // Composer- and editor-replay diffs: side-by-side markdown viewer.
    if (name.endsWith(".diff.md")) {
      return c.html(
        <AdminFixtureMarkdown name={name} content={text} issueId={issueId} />,
      );
    }

    // Editor-replay raw JSON — return as-is for inspection.
    if (name.startsWith("editor-replay-") && name.endsWith(".json")) {
      return c.body(text, 200, { "Content-Type": "application/json" });
    }

    // Scorer fixtures (JSONL).
    const rows = text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as unknown);
    if (rows.length === 0) return c.text("(empty fixture)", 200);
    const first = rows[0] as Record<string, unknown>;
    if ("replay_output" in first || "replay_prompt_version" in first) {
      const replayRows = rows as ReplayRow[];
      return c.html(
        <AdminReplayView
          name={name}
          rows={replayRows}
          summary={summarizeReplay(replayRows)}
        />,
      );
    }
    if ("raw_input" in first && "raw_output" in first) {
      return c.html(<AdminCaptureView name={name} rows={rows as CapturedRow[]} />);
    }
    return c.text("(unknown fixture format)", 200);
  });

  app.post("/admin/config", async (c) => {
    const body = await c.req.parseBody();
    const key = typeof body.key === "string" ? body.key : "";
    const rawValue = typeof body.value === "string" ? body.value : "";
    if (key === "") {
      return c.redirect("/admin/config?error=missing_key", 303);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawValue);
    } catch {
      return c.redirect(
        `/admin/config?error=bad_json&key=${encodeURIComponent(key)}`,
        303,
      );
    }
    const res = await db
      .updateTable("config")
      .set({
        value: JSON.stringify(parsed) as never,
        updated_at: new Date(),
      })
      .where("key", "=", key)
      .executeTakeFirst();
    if (res.numUpdatedRows === BigInt(0)) {
      return c.redirect(
        `/admin/config?error=unknown_key&key=${encodeURIComponent(key)}`,
        303,
      );
    }
    return c.redirect(
      `/admin/config?saved=1&key=${encodeURIComponent(key)}#cfg-${encodeURIComponent(key)}`,
      303,
    );
  });
} else {
  app.all("/admin/*", (c) =>
    c.text(
      "Admin disabled. Set ADMIN_PASSWORD in the environment to enable.",
      503,
    ),
  );
}

app.get("/robots.txt", (c) => {
  // Default: open to crawlers, point at the sitemap. Flip Allow to
  // Disallow during stage-2 (hidden deploy) via env override.
  const blocked = getEnvOptional("BLURPADURP_BLOCK_CRAWLERS") === "1";
  const body = blocked
    ? `User-agent: *\nDisallow: /\n`
    : `User-agent: *\nAllow: /\n\nSitemap: ${PUBLIC_URL}/sitemap.xml\n`;
  return c.body(body, 200, { "Content-Type": "text/plain; charset=utf-8" });
});

app.get("/sitemap.xml", async (c) => {
  const issues = await db
    .selectFrom("issue")
    .select(["id", "published_at"])
    .where("is_draft", "=", false)
    .orderBy("published_at", "desc")
    .limit(1000)
    .execute();
  const urls: Array<{ loc: string; lastmod?: string }> = [
    { loc: `${PUBLIC_URL}/` },
    { loc: `${PUBLIC_URL}/archive` },
    { loc: `${PUBLIC_URL}/about` },
  ];
  for (const iss of issues) {
    urls.push({
      loc: `${PUBLIC_URL}/issue/${Number(iss.id)}`,
      lastmod: iss.published_at.toISOString().slice(0, 10),
    });
  }
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map(
        (u) =>
          `  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`,
      )
      .join("\n") +
    `\n</urlset>\n`;
  return c.body(xml, 200, { "Content-Type": "application/xml; charset=utf-8" });
});

app.get("/feed.xml", async (c) => {
  const rows = await db
    .selectFrom("issue")
    .select(["id", "published_at", "is_event_driven", "title", "composed_html"])
    .where("is_draft", "=", false)
    .orderBy("published_at", "desc")
    .limit(FEED_MAX_ENTRIES)
    .execute();
  const entries = rows.map((r) => ({
    id: Number(r.id),
    publishedAt: r.published_at,
    html: r.composed_html,
    isEventDriven: r.is_event_driven,
    title: r.title,
  }));
  const updated = entries[0]?.publishedAt ?? new Date();
  const xml = renderAtomFeed({ baseUrl: PUBLIC_URL, entries, updated });
  return c.body(xml, 200, { "Content-Type": "application/atom+xml; charset=utf-8" });
});

const SubscribeSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

// Signed-token magic links. No login — the token IS the authorization.
// Scaffolded ahead of dispatch: once dispatch lands, the transactional
// emails will link here. Until then, links can be minted by hand via
// signToken() for testing.

app.get("/confirm/:token", async (c) => {
  const res = verifyToken(c.req.param("token"));
  if (!res.ok || res.payload.kind !== "confirm-email") {
    return c.html(<TokenResultPage title="Link invalid" body="That link is invalid or expired. Subscribe again from the homepage." error />, 400);
  }
  const row = await db
    .updateTable("email_subscription")
    .set({ confirmed_at: new Date() })
    .where("id", "=", res.payload.subscriptionId)
    .where("confirmed_at", "is", null)
    .returning("email")
    .executeTakeFirst();
  const msg = row
    ? `Confirmed — ${row.email}. You'll hear from Blurp when there's something worth reading.`
    : "Already confirmed. Nothing to do.";
  return c.html(<TokenResultPage title="Confirmed" body={msg} />);
});

app.get("/unsubscribe/:token", async (c) => {
  const res = verifyToken(c.req.param("token"));
  if (!res.ok || res.payload.kind !== "unsubscribe-email") {
    return c.html(<TokenResultPage title="Link invalid" body="That link is invalid or expired." error />, 400);
  }
  await db
    .updateTable("email_subscription")
    .set({ unsubscribed_at: new Date() })
    .where("id", "=", res.payload.subscriptionId)
    .where("unsubscribed_at", "is", null)
    .execute();
  return c.html(<TokenResultPage title="Unsubscribed" body="Unsubscribed. No more issues will be sent to this address." />);
});

// RFC 8058 one-click unsubscribe. Mail clients POST here when the user
// hits the native Unsubscribe button (set via the List-Unsubscribe-Post
// header in dispatch.ts).
app.post("/unsubscribe/:token", async (c) => {
  const res = verifyToken(c.req.param("token"));
  if (!res.ok || res.payload.kind !== "unsubscribe-email") {
    return c.text("invalid token", 400);
  }
  await db
    .updateTable("email_subscription")
    .set({ unsubscribed_at: new Date() })
    .where("id", "=", res.payload.subscriptionId)
    .where("unsubscribed_at", "is", null)
    .execute();
  return c.text("ok", 200);
});

app.get("/manage/:token", async (c) => {
  const v = verifyToken(c.req.param("token"));
  if (!v.ok || v.payload.kind !== "manage-email") {
    return c.html(
      <TokenResultPage
        title="Link invalid"
        body="That preferences link is invalid or expired. The next issue you receive will have a fresh one in the footer."
        error
      />,
      400,
    );
  }
  const data = await loadManageData(
    v.payload.subscriptionId,
    c.req.param("token"),
    parseManageFlash(c.req.query("saved"), c.req.query("error")),
  );
  if (data === null) return c.notFound();
  return c.html(<ManagePage data={data} />);
});

app.post("/manage/:token", async (c) => {
  const v = verifyToken(c.req.param("token"));
  if (!v.ok || v.payload.kind !== "manage-email") {
    return c.html(
      <TokenResultPage
        title="Link invalid"
        body="That preferences link is invalid or expired."
        error
      />,
      400,
    );
  }
  const token = c.req.param("token");
  const body = await c.req.parseBody({ all: true });

  // Unsubscribe shortcut.
  if (body.unsubscribe === "1") {
    await db
      .updateTable("email_subscription")
      .set({ unsubscribed_at: new Date() })
      .where("id", "=", v.payload.subscriptionId)
      .where("unsubscribed_at", "is", null)
      .execute();
    return c.html(
      <TokenResultPage
        title="Unsubscribed"
        body="Unsubscribed. No more issues will be sent to this address."
      />,
    );
  }

  const time = typeof body.delivery_time_local === "string"
    ? body.delivery_time_local.trim()
    : "";
  const tz = typeof body.timezone === "string" ? body.timezone.trim() : "";
  const urgent = body.urgent_override === "1";
  const muteRaw = body.mute;
  const mutes = Array.isArray(muteRaw)
    ? muteRaw.filter((v): v is string => typeof v === "string")
    : typeof muteRaw === "string"
      ? [muteRaw]
      : [];

  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(time)) {
    return c.redirect(`/manage/${token}?error=bad_time`, 303);
  }
  if (!isValidTimezone(tz)) {
    return c.redirect(`/manage/${token}?error=bad_tz`, 303);
  }

  // Normalize HH:MM -> HH:MM:00 so Postgres time parsing is happy.
  const normTime = time.length === 5 ? `${time}:00` : time;

  // Only accept category slugs that actually exist.
  const validSlugs = new Set(
    (await db.selectFrom("category").select("slug").execute()).map(
      (r) => r.slug,
    ),
  );
  const cleanMutes = Array.from(new Set(mutes.filter((m) => validSlugs.has(m))));

  await db
    .updateTable("email_subscription")
    .set({
      delivery_time_local: normTime,
      timezone: tz,
      urgent_override: urgent,
      category_mutes: cleanMutes,
    })
    .where("id", "=", v.payload.subscriptionId)
    .execute();

  return c.redirect(`/manage/${token}?saved=1`, 303);
});

app.post("/subscribe", async (c) => {
  const ip = clientIp(c.req.raw.headers, null);
  if (!subscribeLimiter.take(ip)) {
    return c.redirect("/subscribe?error=rate_limited", 303);
  }
  const body = await c.req.parseBody();
  // Honeypot: bots fill every field; humans leave this hidden one empty.
  // Silently redirect as if it succeeded — no signal to the bot.
  if (typeof body.company === "string" && body.company.length > 0) {
    return c.redirect("/subscribe?subscribed=1", 303);
  }
  const parsed = SubscribeSchema.safeParse({ email: body.email });
  if (!parsed.success) {
    return c.redirect("/subscribe?error=invalid_email", 303);
  }
  const email = parsed.data.email;

  // Upsert and get the row id back. ON CONFLICT DO NOTHING returns no
  // row when a conflict happens, so we follow with a SELECT for the
  // already-existing case.
  let row = await db
    .insertInto("email_subscription")
    .values({ email })
    .onConflict((oc) => oc.column("email").doNothing())
    .returning(["id", "confirmed_at"])
    .executeTakeFirst();
  if (row === undefined) {
    row = await db
      .selectFrom("email_subscription")
      .where("email", "=", email)
      .select(["id", "confirmed_at"])
      .executeTakeFirst();
  }
  if (row === undefined) {
    // Shouldn't happen — upsert failed and subsequent lookup also
    // empty. Treat as a validation failure rather than leak a 500.
    return c.redirect("/subscribe?error=invalid_email", 303);
  }

  if (row.confirmed_at !== null) {
    // Already confirmed — don't spam them with another confirmation.
    return c.redirect("/subscribe?subscribed=1&already=1", 303);
  }

  // Mint a signed /confirm/:token magic link and send it. Failure to
  // send is logged but doesn't reveal itself to the user — we never
  // tell a submitter whether their address was deliverable (prevents
  // email-validity probing).
  const token = signToken({
    kind: "confirm-email",
    subscriptionId: Number(row.id),
  });
  const confirmUrl = `${PUBLIC_URL}/confirm/${token}`;
  const mail = renderConfirmationEmail({
    brandUrl: PUBLIC_URL,
    confirmUrl,
  });
  const res = await sendMail({
    to: email,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (!res.ok) {
    console.error(
      `[subscribe] confirmation send failed for ${email}: ${res.error}`,
    );
  }
  return c.redirect("/subscribe?subscribed=1", 303);
});

// Resend webhook endpoint. Register in the Resend dashboard as
// https://<host>/webhooks/resend with event types email.bounced,
// email.complained, email.delivered (optional). Set RESEND_WEBHOOK_SECRET
// to the `whsec_...` value Resend generates.
//
// Hard bounces and complaints auto-unsubscribe. Soft bounces and
// delivery notifications update dispatch_log only (for observability).
app.post("/webhooks/resend", async (c) => {
  const secret = getEnvOptional("RESEND_WEBHOOK_SECRET");
  if (secret === undefined || secret.length === 0) {
    console.error("[resend-webhook] RESEND_WEBHOOK_SECRET not set; rejecting");
    return c.text("webhook not configured", 503);
  }

  const rawBody = await c.req.text();
  const verify = verifySvixSignature({
    body: rawBody,
    svixId: c.req.header("svix-id") ?? "",
    svixTimestamp: c.req.header("svix-timestamp") ?? "",
    svixSignature: c.req.header("svix-signature") ?? "",
    secret,
  });
  if (!verify.ok) {
    console.warn(`[resend-webhook] rejected: ${verify.reason}`);
    return c.text("invalid signature", 401);
  }

  let event: {
    type?: string;
    data?: {
      email_id?: string;
      to?: string | string[];
      bounce?: { type?: string };
    };
  };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return c.text("bad payload", 400);
  }

  const kind = event.type ?? "";
  const data = event.data ?? {};
  const emailId = data.email_id ?? null;
  const recipients = Array.isArray(data.to)
    ? data.to
    : typeof data.to === "string"
      ? [data.to]
      : [];

  // Map event → dispatch_log status string. Keep vocabulary stable so
  // the admin costs/status pages can count categories.
  let status: string | null = null;
  let unsubscribe = false;
  if (kind === "email.delivered") {
    status = "delivered";
  } else if (kind === "email.bounced") {
    const bounceType = data.bounce?.type ?? "";
    if (/hard|undetermined/i.test(bounceType)) {
      status = "bounce_hard";
      unsubscribe = true;
    } else {
      status = "bounce_soft";
    }
  } else if (kind === "email.complained") {
    status = "complaint";
    unsubscribe = true;
  } else if (kind === "email.delivery_delayed") {
    status = "delayed";
  } else {
    // Unknown / uninteresting event — acknowledge, don't retry.
    console.log(`[resend-webhook] ignored event: ${kind}`);
    return c.text("ok", 200);
  }

  // Update dispatch_log row if we can match by provider_message_id.
  // Without a match the event is still useful — we can still
  // unsubscribe on hard bounce / complaint by email.
  if (emailId !== null && status !== null) {
    const updated = await db
      .updateTable("dispatch_log")
      .set({ status })
      .where("provider_message_id", "=", emailId)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) === 0) {
      console.log(
        `[resend-webhook] no dispatch_log match for provider_message_id=${emailId} (${kind})`,
      );
    }
  }

  if (unsubscribe && recipients.length > 0) {
    const res = await db
      .updateTable("email_subscription")
      .set({ unsubscribed_at: new Date() })
      .where("email", "in", recipients.map((r) => r.toLowerCase()))
      .where("unsubscribed_at", "is", null)
      .executeTakeFirst();
    console.log(
      `[resend-webhook] ${kind} → unsubscribed ${Number(res.numUpdatedRows ?? 0)} of ${recipients.length} recipient(s)`,
    );
  }

  return c.text("ok", 200);
});

// --- data loaders ---

async function loadLatestIssue(): Promise<IssueView | null> {
  const row = await db
    .selectFrom("issue")
    .select(["id", "published_at", "is_event_driven", "title", "composed_html"])
    .where("is_draft", "=", false)
    .orderBy("published_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: Number(row.id),
    publishedAt: row.published_at,
    isEventDriven: row.is_event_driven,
    title: row.title,
    html: row.composed_html,
  };
}

async function loadIssue(id: number): Promise<IssueView | null> {
  const row = await db
    .selectFrom("issue")
    .select(["id", "published_at", "is_event_driven", "title", "composed_html"])
    .where("id", "=", id)
    .where("is_draft", "=", false)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: Number(row.id),
    publishedAt: row.published_at,
    isEventDriven: row.is_event_driven,
    title: row.title,
    html: row.composed_html,
  };
}

async function listFixtures(): Promise<FixtureFile[]> {
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

async function loadCostData(): Promise<CostDashboardData> {
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

function clampInt(
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

async function loadExplorerData(): Promise<ExplorerData> {
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

function parseStoryFilter(q: Record<string, string>): StoryFilter {
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

async function loadStoriesData(filter: StoryFilter): Promise<StoriesData> {
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

  const [cats, srcs, facs] = await Promise.all([
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
  ]);

  return {
    filter,
    total,
    page,
    pageSize,
    categories: cats.map((r) => r.slug),
    sources: srcs.map((r) => r.source_name),
    factors: facs.map((r) => r.factor),
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
    })),
  };
}

async function loadStoryDrilldown(id: number): Promise<StoryDrilldown | null> {
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

  return {
    id: Number(row.id),
    title: row.title,
    summary: row.summary,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    sourceHost: extractHost(row.source_url),
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
    rawInput: row.raw_input,
    rawOutput: row.raw_output,
  };
}

function parseDroppedFilter(q: Record<string, string>): DroppedFilter {
  const win = Number(q.window);
  const windowDays = [7, 14, 30, 60, 90].includes(win) ? win : 30;
  return { windowDays, category: q.category || undefined };
}

async function loadDroppedData(filter: DroppedFilter): Promise<DroppedData> {
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

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function parseBalanceFilter(q: Record<string, string>): BalanceFilter {
  const win = Number(q.window);
  const windowWeeks = [4, 8, 12, 26, 52].includes(win) ? win : 12;
  return { windowWeeks };
}

async function loadBalanceData(filter: BalanceFilter): Promise<BalanceData> {
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

async function loadGateSandboxData(params: {
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

async function loadEvalStats(): Promise<EvalStats> {
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
async function loadNextEvalCandidate(): Promise<EvalCandidate | null> {
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
      "story.ingested_at",
    ])
    .where("story.scored_at", "is not", null)
    .where("story.early_reject", "=", false)
    .where("eval_label.story_id", "is", null)
    .orderBy("story.composite", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  const r = row.raw_output as
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

function parseThemeFilter(raw: string | undefined): ThemeFilter {
  if (raw === "long_running" || raw === "rising" || raw === "active") {
    return raw;
  }
  return "all";
}

function parseFlashGeneric(
  saved: string | undefined,
  error: string | undefined,
): ThemesData["flash"] {
  if (saved) return { kind: "ok", msg: "Saved." };
  if (error === "bad_id") return { kind: "error", msg: "Bad theme id." };
  return null;
}

async function loadSourcesData(
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
  const byConnector = registered.map((c) => ({
    source: c.name,
    ingested: ingestMap.get(c.name) ?? 0,
  }));
  // Tail any source_name in the data that isn't in the registry (old
  // connectors that have been removed) so the diagnostic doesn't lie.
  const knownNames = new Set(byConnector.map((b) => b.source));
  for (const r of ingestRows) {
    if (!knownNames.has(r.source_name)) {
      byConnector.push({ source: r.source_name, ingested: Number(r.n) });
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

async function loadThemesData(
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

async function loadThemeDetail(id: number): Promise<ThemeDetailData | null> {
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

async function loadEditorSandboxData(): Promise<EditorSandboxData> {
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

async function loadThemeGraphData(filters: {
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

function domainOfUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

async function loadConfigRows(): Promise<ConfigRow[]> {
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

function parseConfigFlash(
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

async function loadTheme(id: number): Promise<ThemeViewData | null> {
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
      "raw_output",
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
  const issueOf = new Map<number, number>();
  if (storyIdSet.size > 0) {
    const issueRows = await db
      .selectFrom("issue")
      .select(["id", "story_ids"])
      .where("is_draft", "=", false)
      .orderBy("published_at", "desc")
      .execute();
    for (const iss of issueRows) {
      for (const sid of iss.story_ids ?? []) {
        const n = Number(sid);
        if (storyIdSet.has(n) && !issueOf.has(n)) issueOf.set(n, Number(iss.id));
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
      const r = s.raw_output as { summary?: string; one_line_summary?: string } | null;
      return {
        id: Number(s.id),
        title: s.title,
        publishedAt: s.published_at,
        publishedToReader: s.published_to_reader,
        sourceUrl: s.source_url,
        oneLiner: r?.summary ?? r?.one_line_summary ?? "",
        issueId: issueOf.get(Number(s.id)) ?? null,
      };
    }),
  };
}

// Used both by the full review-page loader (loadReview) and by the
// HTMX annotate/delete handlers that re-render just the list fragment.
async function loadAnnotations(issueId: number): Promise<Annotation[]> {
  const rows = await db
    .selectFrom("issue_annotation")
    .select(["id", "slot", "body", "anchor_key", "created_at"])
    .where("issue_id", "=", issueId)
    .orderBy("created_at", "desc")
    .execute();
  return rows.map((r) => ({
    id: Number(r.id),
    slot: r.slot,
    body: r.body,
    anchorKey: r.anchor_key,
    createdAt: r.created_at,
  }));
}

// Look up the issue's composedHtml just to extract anchor snippets.
// HTMX annotate/delete responses re-render the sidebar fragment, which
// needs the snippet labels to keep group headings in sync.
async function loadIssueSnippets(
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

async function loadReview(id: number): Promise<EditorReviewData | null> {
  const iss = await db
    .selectFrom("issue")
    .select([
      "id",
      "published_at",
      "is_event_driven",
      "is_draft",
      "composer_prompt_version",
      "composer_model_id",
      "story_ids",
      "composed_html",
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
    .select(["id", "slot", "body", "anchor_key", "created_at"])
    .where("issue_id", "=", id)
    .orderBy("created_at", "desc")
    .execute();

  return {
    issue: {
      id: Number(iss.id),
      publishedAt: iss.published_at,
      isEventDriven: iss.is_event_driven,
      isDraft: iss.is_draft,
      composerPromptVersion: iss.composer_prompt_version,
      composerModelId: iss.composer_model_id,
      composedHtml: iss.composed_html,
    },
    annotations: annotations.map((a) => ({
      id: Number(a.id),
      slot: a.slot,
      body: a.body,
      anchorKey: a.anchor_key,
      createdAt: a.created_at,
    })),
    editor: iss.editor_output_jsonb as EditorReviewData["editor"],
    storyTitles,
    storyThemes,
    shrug: (iss.shrug_candidates_jsonb as EditorReviewData["shrug"]) ?? [],
  };
}

// Scan fixtures/ for composer-replay-i<N>-<stamp>.html files, group
// their base names by issue id. One pass covers every issue.
async function loadReplaysByIssue(): Promise<Map<number, Array<{ base: string; mtime: Date }>>> {
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

async function loadManageData(
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

function parseManageFlash(
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
function isValidTimezone(tz: string): boolean {
  if (tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function loadReplaysForIssue(
  issueId: number,
): Promise<Array<{ base: string; mtime: Date }>> {
  const all = await loadReplaysByIssue();
  return all.get(issueId) ?? [];
}

// Editor replays are named editor-replay-i<N>-<stamp>.diff.md (and .json).
// We key on the .diff.md since that's what the admin review page links to.
async function loadEditorReplaysForIssue(
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

async function loadAdminIssues(): Promise<AdminIssueRow[]> {
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

async function loadArchive(): Promise<ArchiveEntry[]> {
  const rows = await db
    .selectFrom("issue")
    .select(["id", "published_at", "is_event_driven", "title"])
    .where("is_draft", "=", false)
    .orderBy("published_at", "desc")
    .execute();
  return rows.map((r) => ({
    id: Number(r.id),
    publishedAt: r.published_at,
    isEventDriven: r.is_event_driven,
    title: r.title,
  }));
}

function parseFlash(
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

async function loadPromptEditor(
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

function parsePromptFlash(
  q: Record<string, string>,
): { kind: "ok"; msg: string } | { kind: "err"; msg: string } | null {
  if (q.saved === "1") return { kind: "ok", msg: "Staged." };
  if (q.cleared === "1")
    return { kind: "ok", msg: "Staged prompt cleared — falls back to file." };
  if (q.error === "empty") return { kind: "err", msg: "Prompt is empty." };
  return null;
}

function parseReviewFlash(
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
  return null;
}

app.notFound((c) => c.html(<NotFoundPage />, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  console.error("[api]", err);
  const detail =
    getEnvOptional("NODE_ENV") === "production"
      ? undefined
      : err instanceof Error
        ? err.stack ?? err.message
        : String(err);
  return c.html(<ServerErrorPage detail={detail} />, 500);
});

// Run directly: `bun run src/api/index.ts`
if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  // Bind to 0.0.0.0 so Fly's proxy (and any container runtime) can
  // reach the socket. Bun.serve defaults to localhost otherwise, which
  // is invisible from outside the machine's network namespace.
  const hostname = "0.0.0.0";
  console.log(`listening on http://${hostname}:${port}`);
  Bun.serve({ port, hostname, fetch: app.fetch });
}
