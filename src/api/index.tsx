// Hono app: public archive, subscription endpoints, preference pages.
// No accounts — subscription is the identity. All routes are public.

import { Hono, type Context } from "hono";
import { basicAuth } from "hono/basic-auth";
import { serveStatic } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import { sql } from "kysely";
import { resolve } from "node:path";
import { z } from "zod";

import { db } from "../db/index.ts";
import {
  discardDraft,
  publishDraft,
  recomposeDraft,
  reeditDraft,
  replayReplaceIssue,
} from "../pipeline/draft.ts";
import type {
  CapturedRow,
  ReplayRow,
} from "../pipeline/fixture.ts";
import { replayComposer, summarizeReplay } from "../pipeline/fixture.ts";
import { loadPipelineStatus } from "./status.ts";
import { loadStorageStatus } from "./storage-status.ts";
import { servePage } from "../shared/page-cache.ts";
import { AdminStatus } from "../views/admin-status.tsx";
import { getEnvOptional } from "../shared/env.ts";
import { sendMail } from "../shared/mailer.ts";
import { notifyAdmin, renderAdminNotice } from "../shared/admin-notify.ts";
import {
  clientIp,
  makeRateLimiter,
  withinCooldown,
} from "../shared/rate-limit.ts";
import { normalizeHost } from "../shared/source-blocklist.ts";
import { securityHeaders } from "../shared/security-headers.ts";
import { verifySvixSignature } from "../shared/svix.ts";
import { signToken, verifyToken } from "../shared/tokens.ts";
import { About } from "../views/about.tsx";
import {
  AdminConfig,
} from "../views/admin-config.tsx";
import {
  AdminCosts,
} from "../views/admin-costs.tsx";
import {
  AdminEval,
} from "../views/admin-eval.tsx";
import {
  AdminExplore,
} from "../views/admin-explore.tsx";
import {
  AdminExploreGate,
} from "../views/admin-explore-gate.tsx";
import {
  AdminExploreStories,
} from "../views/admin-explore-stories.tsx";
import {
  AdminExploreDropped,
} from "../views/admin-explore-dropped.tsx";
import {
  AdminExploreBalance,
} from "../views/admin-explore-balance.tsx";
import {
  AdminExploreStory,
} from "../views/admin-explore-story.tsx";
import {
  AdminCaptureView,
  AdminFixtureMarkdown,
  AdminFixturesList,
  AdminReplayBrief,
  AdminReplayView,
} from "../views/admin-fixtures.tsx";
import {
  AdminIssues,
} from "../views/admin-issues.tsx";
import {
  AdminPrompts,
  type PromptStageKey,
} from "../views/admin-prompts.tsx";
import {
  AdminReview,
  AnnotationsList,
} from "../views/admin-review.tsx";
import {
  AdminThemes,
} from "../views/admin-themes.tsx";
import {
  AdminThemeDetail,
} from "../views/admin-theme-detail.tsx";
import {
  AdminThemeGraph,
} from "../views/admin-theme-graph.tsx";
import {
  AdminSources,
  type HostSortDir,
  type HostSortKey,
} from "../views/admin-sources.tsx";
import {
  AdminReviewers,
} from "../views/admin-reviewers.tsx";
import {
  AdminPathFilters,
} from "../views/admin-path-filters.tsx";
import {
  AdminTitleFilters,
} from "../views/admin-title-filters.tsx";
import { validateTitleRegex } from "../shared/title-noise.ts";
import {
  AdminScheduler,
} from "../views/admin-scheduler.tsx";
import {
  getStage as getSchedulerStage,
} from "../scheduler.ts";
import {
  AdminEditorSandbox,
} from "../views/admin-editor-sandbox.tsx";
import { Archive, } from "../views/archive.tsx";
import {
  DraftPreview,
} from "../views/draft-preview.tsx";
import { renderConfirmationEmail } from "../views/email.ts";
import {
  ManagePage,
} from "../views/manage.tsx";
import { Privacy } from "../views/privacy.tsx";
import { NotFoundPage, ServerErrorPage } from "../views/error-pages.tsx";
import { renderAtomFeed } from "../views/feed.ts";
import { Home, } from "../views/home.tsx";
import { IssuePage, } from "../views/issue.tsx";
import { SubscribePage } from "../views/subscribe.tsx";
import { ThemePage, } from "../views/theme.tsx";
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

// Per-recipient resend cooldown (mig 061). A human who lost the
// confirmation mail can re-request after this window; a bomber re-submitting
// the same victim address is capped to one mail per window.
const CONFIRMATION_COOLDOWN_MS = 15 * 60_000;

// Global confirmation-send cap (audit M1, distributed-IP abuse). The per-IP
// subscribeLimiter only throttles a single source; distinct IPs (a botnet)
// against distinct addresses still drives unbounded outbound mail on our
// sending domain. This token bucket is keyed on a fixed string so every
// accepted send draws from one shared budget: 60 burst, refill 1/min
// (~1440/day sustained) — generous for an organic signup spike, hard ceiling
// on abuse. In-memory/single-node by design (Cloudflare is the real DoS
// layer); the bucket persists across a sustained attack since the machine
// stays awake, and resets only on an idle restart. When it trips we drop the
// send silently (no enumeration signal) and alert the operator.
const CONFIRMATION_SEND_GLOBAL_KEY = "confirmation-send";
const confirmationSendLimiter = makeRateLimiter({
  capacity: 60,
  refillPerMs: 1 / 60_000,
});

// Coarse per-IP limiter shared across the signed-token routes (/confirm,
// /unsubscribe, /manage, /draft). HMAC verification is already
// constant-time, so these aren't an enumeration vector — this is cheap noise
// control against a script hammering them. Generous: 20 burst, refill 1 per
// 5s (= 720/hour sustained).
const tokenRouteLimiter = makeRateLimiter({
  capacity: 20,
  refillPerMs: 1 / 5_000,
});

export const app = new Hono();

// Strict security headers (static CSP, nosniff, frame-deny, HSTS).
// Applied globally so admin pages benefit too. HSTS off on localhost —
// turn it on for anything with a trusted HTTPS cert.
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

// Coarse per-IP throttle on the signed-token routes. Registered before the
// handlers so it wraps them. A tripped bucket returns a plain 429 rather
// than a branded page — these aren't reader-facing happy paths.
const tokenRouteGuard = async (
  c: Context,
  next: () => Promise<void>,
): Promise<Response | void> => {
  const ip = clientIp(c.req.raw.headers, null);
  if (!tokenRouteLimiter.take(ip)) {
    return c.text("Too many requests. Please slow down.", 429);
  }
  await next();
};
app.use("/confirm/*", tokenRouteGuard);
app.use("/unsubscribe/*", tokenRouteGuard);
app.use("/manage/*", tokenRouteGuard);
app.use("/draft/*", tokenRouteGuard);

// /health is the process-alive probe for Fly's http_service check. It
// MUST NOT touch the database — Fly hits it every minute, and any DB
// call would keep Neon warm continuously and blow the free tier. The
// DB-backed freshness payload lives at /status (for external monitors
// like Uptime Kuma or healthchecks.io) and at /admin/status (HTML for
// the operator).
app.get("/health", (c) => c.json({ ok: true }));

app.get("/status", async (c) => {
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

// Render a server JSX node to an HTML string. Handles both sync and
// (defensively) async component trees so cached bodies are plain
// strings.
function renderHtml(node: unknown): Promise<string> {
  return Promise.resolve(
    (node as { toString(): string | Promise<string> }).toString(),
  ).then(String);
}

app.get("/", async (c) => {
  // Served from the R2 page cache (busted on publish) so crawler/reader
  // traffic doesn't wake Neon between weekly issues. See page-cache.ts.
  const body = await servePage("home", async () => {
    const home = await loadHome();
    return renderHtml(<Home home={home} flash={null} />);
  });
  return c.html(body ?? "", 200, { "Cache-Control": "public, max-age=600" });
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
  const body = await servePage("archive", async () => {
    const issues = await loadArchive();
    return renderHtml(<Archive issues={issues} />);
  });
  return c.html(body ?? "", 200, { "Cache-Control": "public, max-age=600" });
});

app.get("/issue/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) return c.notFound();
  // Published issues are immutable, so a longer TTL is safe; recompose
  // is rare and admin-driven.
  const body = await servePage(
    `issue-${id}`,
    async () => {
      const issue = await loadIssue(id);
      return issue === null ? null : renderHtml(<IssuePage issue={issue} />);
    },
    6 * 3600,
  );
  if (body === null) return c.notFound();
  return c.html(body, 200, { "Cache-Control": "public, max-age=3600" });
});

// Draft preview for non-admin reviewers. Authorized via a signed
// magic-link token (kind=draft-preview) generated from the admin
// review page. The token carries the issue id + reviewer's display
// name; the reviewer can read the draft and leave feedback (stored
// in issue_annotation with reviewer_name set) but cannot publish,
// discard, or recompose. Tokens expire after 14 days.
app.get("/draft/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) return c.notFound();
  const tokenStr = c.req.query("token") ?? "";
  if (tokenStr.length === 0) return c.notFound();
  const v = verifyToken(tokenStr);
  if (!v.ok) return c.notFound();
  if (
    v.payload.kind !== "draft-preview" ||
    v.payload.subscriptionId !== id ||
    v.payload.reviewerName === undefined
  ) {
    return c.notFound();
  }
  const data = await loadDraftForPreview(id);
  if (data === null) return c.notFound();
  const flash = parseDraftFlash(c.req.query("noted"), c.req.query("error"));
  return c.html(
    <DraftPreview
      data={{
        issue: data,
        reviewerName: v.payload.reviewerName,
        token: tokenStr,
        annotations: await loadAnnotations(id),
      }}
      flash={flash}
    />,
  );
});

app.post("/draft/:id/notes", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) return c.notFound();
  const tokenStr = c.req.query("token") ?? "";
  if (tokenStr.length === 0) return c.notFound();
  const v = verifyToken(tokenStr);
  if (!v.ok) return c.notFound();
  if (
    v.payload.kind !== "draft-preview" ||
    v.payload.subscriptionId !== id ||
    v.payload.reviewerName === undefined
  ) {
    return c.notFound();
  }
  const draft = await loadDraftForPreview(id);
  if (draft === null) return c.notFound();
  const body = await c.req.parseBody();
  const text = String(body.body ?? "").trim();
  const rawAnchor = String(body.anchor_key ?? "").trim();
  const anchorKey = rawAnchor.length > 0 ? rawAnchor : null;
  const back = `/draft/${id}?token=${encodeURIComponent(tokenStr)}`;
  if (text.length === 0) return c.redirect(`${back}&error=empty`, 303);
  if (text.length > 5000) return c.redirect(`${back}&error=too_long`, 303);
  await db
    .insertInto("issue_annotation")
    .values({
      issue_id: id,
      slot: "general",
      body: text,
      anchor_key: anchorKey,
      reviewer_name: v.payload.reviewerName,
    })
    .execute();
  return c.redirect(`${back}&noted=1#notes`, 303);
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
    const shareToken = c.req.query("share_token");
    const shareName = c.req.query("share_name");
    const share =
      shareToken !== undefined &&
      shareToken.length > 0 &&
      shareName !== undefined &&
      shareName.length > 0
        ? {
            url: `${PUBLIC_URL}/draft/${id}?token=${encodeURIComponent(shareToken)}`,
            reviewerName: shareName,
          }
        : null;
    return c.html(
      <AdminReview
        data={data}
        replays={replays}
        editorReplays={editorReplays}
        flash={flash}
        share={share}
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

  app.post("/admin/review/:id/edit", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const body = await c.req.parseBody();
    const title = String(body.title ?? "").trim();
    const composedHtml = String(body.composed_html ?? "");
    const composedMarkdown = String(body.composed_markdown ?? "");
    if (title.length === 0 || composedHtml.length === 0) {
      return c.redirect(`/admin/review/${id}?error=empty_edit`, 303);
    }
    const updated = await db
      .updateTable("issue")
      .set({
        title,
        composed_html: composedHtml,
        composed_markdown: composedMarkdown,
      })
      .where("id", "=", id)
      .where("is_draft", "=", true)
      .returning("id")
      .executeTakeFirst();
    if (updated === undefined) {
      return c.redirect(`/admin/review/${id}?error=not_draft`, 303);
    }
    return c.redirect(`/admin/review/${id}?edited=1`, 303);
  });

  // Non-destructive composer replay: re-runs the composer on the
  // issue's persisted composer_input_jsonb using the current prompt +
  // model from config, writes the result to fixtures/, and never
  // touches the issue row. Works for both drafts and published issues
  // — the point is to preview how the latest prompt would render a
  // past issue without overwriting it.
  app.post("/admin/review/:id/replay-composer", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    try {
      await replayComposer({ issueId: id });
    } catch (err) {
      console.error("[replay-composer]", err);
      return c.redirect(`/admin/review/${id}?error=replay_failed`, 303);
    }
    return c.redirect(`/admin/review/${id}?replayed=1`, 303);
  });

  // Destructive: re-runs the composer using the current prompt + model
  // and overwrites the issue's stored prose. Same code path as
  // recomposeDraft minus the is_draft gate. Cheat hatch for the rare
  // case where a prompt rev produces meaningfully better prose than
  // what shipped and the audience is small enough that rewriting a
  // published issue in-place is acceptable. The UI gates this behind a
  // strong confirm.
  app.post("/admin/review/:id/replay-replace", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    try {
      const res = await replayReplaceIssue(id);
      if (!res.ok) {
        return c.redirect(`/admin/review/${id}?error=${res.reason}`, 303);
      }
    } catch (err) {
      console.error("[replay-replace]", err);
      return c.redirect(`/admin/review/${id}?error=replay_replace_failed`, 303);
    }
    return c.redirect(`/admin/review/${id}?replay_replaced=1`, 303);
  });

  app.post("/admin/review/:id/share", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const body = await c.req.parseBody();
    const reviewerName = String(body.reviewer_name ?? "").trim().slice(0, 60);
    if (reviewerName.length === 0) {
      return c.redirect(`/admin/review/${id}?error=empty_reviewer`, 303);
    }
    const iss = await db
      .selectFrom("issue")
      .select("is_draft")
      .where("id", "=", id)
      .executeTakeFirst();
    if (iss === undefined || !iss.is_draft) {
      return c.redirect(`/admin/review/${id}?error=not_draft_share`, 303);
    }
    const token = signToken({
      kind: "draft-preview",
      subscriptionId: id,
      reviewerName,
    });
    const params = new URLSearchParams({
      shared: "1",
      share_token: token,
      share_name: reviewerName,
    });
    return c.redirect(`/admin/review/${id}?${params.toString()}#share`, 303);
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
    const [s, storage] = await Promise.all([
      loadPipelineStatus(),
      loadStorageStatus(),
    ]);
    return c.html(<AdminStatus s={s} storage={storage} />);
  });

  app.get("/admin/scheduler", async (c) => {
    const q = c.req.query();
    const flash =
      q.triggered || q.cleared || q.saved
        ? {
            triggered: q.triggered,
            cleared: q.cleared,
            saved: q.saved,
          }
        : null;
    const data = await loadSchedulerData(flash);
    return c.html(<AdminScheduler d={data} />);
  });

  app.post("/admin/scheduler/edit", async (c) => {
    const form = await c.req.parseBody();
    const stage = String(form.stage ?? "");
    if (getSchedulerStage(stage) === undefined) return c.text("unknown stage", 404);
    const intervalSec = Number(form.interval_sec);
    const enabled = String(form.enabled ?? "1") === "1";
    if (!Number.isFinite(intervalSec) || intervalSec < 60) {
      return c.redirect("/admin/scheduler", 303);
    }
    await db
      .updateTable("pipeline_schedule")
      .set({ interval_sec: Math.floor(intervalSec), enabled, updated_at: sql`now()` })
      .where("stage", "=", stage)
      .execute();
    return c.redirect(`/admin/scheduler?saved=${encodeURIComponent(stage)}`, 303);
  });

  // Manual trigger. Inserts a row into pipeline_force_run; the next
  // scheduler tick (≤1h) drains it and fires the stage on the
  // scheduler machine. We do NOT run pipeline work on the http_service
  // — long stages outlast Fly's idle-stop and get killed mid-flight.
  app.post("/admin/run/:stage", async (c) => {
    const stage = c.req.param("stage");
    if (getSchedulerStage(stage) === undefined) return c.text("unknown stage", 404);
    await db
      .insertInto("pipeline_force_run")
      .values({ stage })
      .onConflict((oc) => oc.column("stage").doNothing())
      .execute();
    return c.redirect(`/admin/scheduler?triggered=${encodeURIComponent(stage)}`, 303);
  });

  app.post("/admin/lock/:stage/clear", async (c) => {
    const stage = c.req.param("stage");
    if (getSchedulerStage(stage) === undefined) return c.text("unknown stage", 404);
    await db.deleteFrom("pipeline_lock").where("stage_name", "=", stage).execute();
    return c.redirect(`/admin/scheduler?cleared=${encodeURIComponent(stage)}`, 303);
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

  app.get("/admin/reviewers", async (c) => {
    const data = await loadReviewersData(c.req.query());
    return c.html(<AdminReviewers data={data} />);
  });

  // Add a reviewer by email. Upsert: if the address already exists we
  // flip is_reviewer on (and clear an unsubscribe) rather than erroring;
  // a fresh address is inserted pre-confirmed so dispatch sends to it on
  // the next sweep without a confirmation round-trip (operator-curated).
  app.post("/admin/reviewers/add", async (c) => {
    const body = await c.req.parseBody();
    const email = String(body.email ?? "").trim().toLowerCase();
    // Same shallow check the public subscribe path uses — a real address
    // has one @ with text either side. Resend rejects the rest.
    if (email.length === 0 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return c.redirect("/admin/reviewers?error=bad_email", 303);
    }
    await db
      .insertInto("email_subscription")
      .values({ email, confirmed_at: new Date(), is_reviewer: true })
      .onConflict((oc) =>
        oc.column("email").doUpdateSet({
          is_reviewer: true,
          unsubscribed_at: null,
          confirmed_at: sql`coalesce(email_subscription.confirmed_at, now())`,
        }),
      )
      .execute();
    return c.redirect(
      `/admin/reviewers?added=${encodeURIComponent(email)}`,
      303,
    );
  });

  app.post("/admin/reviewers/:id/toggle", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const body = await c.req.parseBody();
    const make = String(body.make ?? "") === "1";
    const updated = await db
      .updateTable("email_subscription")
      .set({ is_reviewer: make })
      .where("id", "=", id)
      .returning("email")
      .executeTakeFirst();
    if (updated === undefined) {
      return c.redirect("/admin/reviewers?error=no_subscription", 303);
    }
    return c.redirect(
      `/admin/reviewers?${make ? "promoted" : "demoted"}=${encodeURIComponent(updated.email)}`,
      303,
    );
  });

  app.get("/admin/path-filters", async (c) => {
    const q = c.req.query();
    const flash =
      q.added || q.removed || q.toggled || q.error
        ? {
            added: q.added,
            removed: q.removed,
            toggled: q.toggled,
            error: q.error,
          }
        : null;
    const data = await loadPathFiltersData(flash);
    return c.html(<AdminPathFilters d={data} />);
  });

  app.post("/admin/path-filters/add", async (c) => {
    const body = await c.req.parseBody();
    const pattern = normalizePathPattern(String(body.pattern ?? ""));
    const mode = String(body.mode ?? "block") === "tag" ? "tag" : "block";
    const note = String(body.note ?? "").trim().slice(0, 400) || null;
    if (pattern === null) {
      return c.redirect(
        "/admin/path-filters?error=" + encodeURIComponent("pattern required"),
        303,
      );
    }
    try {
      await db
        .insertInto("url_path_filter")
        .values({ pattern, mode, note })
        .execute();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.redirect(
        "/admin/path-filters?error=" + encodeURIComponent(msg.slice(0, 200)),
        303,
      );
    }
    return c.redirect(
      "/admin/path-filters?added=" + encodeURIComponent(pattern),
      303,
    );
  });

  app.post("/admin/path-filters/toggle", async (c) => {
    const body = await c.req.parseBody();
    const pattern = String(body.pattern ?? "");
    const row = await db
      .selectFrom("url_path_filter")
      .select(["mode"])
      .where("pattern", "=", pattern)
      .executeTakeFirst();
    if (!row) return c.redirect("/admin/path-filters", 303);
    const next = row.mode === "block" ? "tag" : "block";
    await db
      .updateTable("url_path_filter")
      .set({ mode: next })
      .where("pattern", "=", pattern)
      .execute();
    return c.redirect(
      "/admin/path-filters?toggled=" + encodeURIComponent(pattern),
      303,
    );
  });

  app.post("/admin/path-filters/delete", async (c) => {
    const body = await c.req.parseBody();
    const pattern = String(body.pattern ?? "");
    await db
      .deleteFrom("url_path_filter")
      .where("pattern", "=", pattern)
      .execute();
    return c.redirect(
      "/admin/path-filters?removed=" + encodeURIComponent(pattern),
      303,
    );
  });

  app.get("/admin/title-filters", async (c) => {
    const q = c.req.query();
    const flash =
      q.added || q.removed || q.toggled || q.error
        ? {
            added: q.added,
            removed: q.removed,
            toggled: q.toggled,
            error: q.error,
          }
        : null;
    const data = await loadTitleFiltersData(flash);
    return c.html(<AdminTitleFilters d={data} />);
  });

  app.post("/admin/title-filters/add", async (c) => {
    const body = await c.req.parseBody();
    // Title regex is opaque user input — preserve case (regex flags
    // already force `i`-mode at compile time) and only trim outer
    // whitespace. Empty after trim → reject.
    const pattern = String(body.pattern ?? "").trim();
    const mode = String(body.mode ?? "block") === "tag" ? "tag" : "block";
    const note = String(body.note ?? "").trim().slice(0, 400) || null;
    if (pattern.length === 0 || pattern.length > 500) {
      return c.redirect(
        "/admin/title-filters?error=" +
          encodeURIComponent("pattern must be 1–500 chars"),
        303,
      );
    }
    const v = validateTitleRegex(pattern);
    if (!v.ok) {
      return c.redirect(
        "/admin/title-filters?error=" +
          encodeURIComponent("invalid regex: " + v.error),
        303,
      );
    }
    try {
      await db
        .insertInto("title_regex_filter")
        .values({ pattern, mode, note })
        .execute();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.redirect(
        "/admin/title-filters?error=" + encodeURIComponent(msg.slice(0, 200)),
        303,
      );
    }
    return c.redirect(
      "/admin/title-filters?added=" + encodeURIComponent(pattern),
      303,
    );
  });

  app.post("/admin/title-filters/toggle", async (c) => {
    const body = await c.req.parseBody();
    const pattern = String(body.pattern ?? "");
    const row = await db
      .selectFrom("title_regex_filter")
      .select(["mode"])
      .where("pattern", "=", pattern)
      .executeTakeFirst();
    if (!row) return c.redirect("/admin/title-filters", 303);
    const next = row.mode === "block" ? "tag" : "block";
    await db
      .updateTable("title_regex_filter")
      .set({ mode: next })
      .where("pattern", "=", pattern)
      .execute();
    return c.redirect(
      "/admin/title-filters?toggled=" + encodeURIComponent(pattern),
      303,
    );
  });

  app.post("/admin/title-filters/delete", async (c) => {
    const body = await c.req.parseBody();
    const pattern = String(body.pattern ?? "");
    await db
      .deleteFrom("title_regex_filter")
      .where("pattern", "=", pattern)
      .execute();
    return c.redirect(
      "/admin/title-filters?removed=" + encodeURIComponent(pattern),
      303,
    );
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
  const xml = await servePage("sitemap", async () => {
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
    return (
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls
        .map(
          (u) =>
            `  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`,
        )
        .join("\n") +
      `\n</urlset>\n`
    );
  });
  return c.body(xml ?? "", 200, {
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": "public, max-age=600",
  });
});

app.get("/feed.xml", async (c) => {
  const xml = await servePage("feed", async () => {
    const rows = await db
      .selectFrom("issue")
      .select(["id", "published_seq", "published_at", "is_event_driven", "title", "composed_html"])
      .where("is_draft", "=", false)
      .orderBy("published_at", "desc")
      .limit(FEED_MAX_ENTRIES)
      .execute();
    const entries = rows.map((r) => ({
      id: Number(r.id),
      publishedSeq: r.published_seq,
      publishedAt: r.published_at,
      html: r.composed_html,
      isEventDriven: r.is_event_driven,
      title: r.title,
    }));
    const updated = entries[0]?.publishedAt ?? new Date();
    return renderAtomFeed({ baseUrl: PUBLIC_URL, entries, updated });
  });
  return c.body(xml ?? "", 200, {
    "Content-Type": "application/atom+xml; charset=utf-8",
    "Cache-Control": "public, max-age=600",
  });
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
    .returning(["id", "confirmed_at", "last_confirmation_sent_at"])
    .executeTakeFirst();
  if (row === undefined) {
    row = await db
      .selectFrom("email_subscription")
      .where("email", "=", email)
      .select(["id", "confirmed_at", "last_confirmation_sent_at"])
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

  // Per-recipient cooldown (mig 061). Re-submitting an unconfirmed address
  // would otherwise re-send a confirmation every time, so a victim address
  // could be bombed. Inside the window we skip the send but return the same
  // subscribed=1 redirect — the response must never reveal whether the
  // address exists or was just throttled.
  if (withinCooldown(row.last_confirmation_sent_at, CONFIRMATION_COOLDOWN_MS)) {
    return c.redirect("/subscribe?subscribed=1", 303);
  }

  // Global outbound-confirmation cap. Bounds blast radius from distributed
  // IPs that the per-IP limiter can't see. On a trip we drop the send
  // silently (same redirect, no enumeration signal) and alert the operator
  // — a dedupe key keeps it to one mail per window instead of one per
  // dropped send.
  if (!confirmationSendLimiter.take(CONFIRMATION_SEND_GLOBAL_KEY)) {
    console.warn("[subscribe] global confirmation-send cap tripped; dropping");
    const notice = renderAdminNotice({
      heading: "Confirmation-email cap tripped",
      bodyLines: [
        "The global outbound-confirmation rate limit was hit, so new " +
          "confirmation emails are being dropped.",
        "This usually means a distributed signup flood. Check /admin and " +
          "the edge (Cloudflare) if this persists.",
      ],
    });
    await notifyAdmin({
      subject: "Blurpadurp: confirmation-email cap tripped",
      html: notice.html,
      text: notice.text,
      dedupeKey: "confirmation-send-cap",
      cooldownMs: 60 * 60_000,
    });
    return c.redirect("/subscribe?subscribed=1", 303);
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
  // Stamp the send time before awaiting the network call so concurrent
  // resubmits of the same address can't slip past the cooldown. We stamp
  // even on send failure: a bouncing/erroring address shouldn't be a
  // retry-spam loophole, and the operator-facing error is logged below.
  await db
    .updateTable("email_subscription")
    .set({ last_confirmation_sent_at: new Date() })
    .where("id", "=", Number(row.id))
    .execute();
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


// Data loaders + parse helpers (extracted to keep this file to routing).
import {
  loadHome,
  loadIssue,
  loadDraftForPreview,
  parseDraftFlash,
  listFixtures,
  loadCostData,
  clampInt,
  loadExplorerData,
  parseStoryFilter,
  normalizePathPattern,
  loadPathFiltersData,
  loadTitleFiltersData,
  loadSchedulerData,
  loadStoriesData,
  loadStoryDrilldown,
  parseDroppedFilter,
  loadDroppedData,
  parseBalanceFilter,
  loadBalanceData,
  loadGateSandboxData,
  loadEvalStats,
  loadNextEvalCandidate,
  parseThemeFilter,
  parseFlashGeneric,
  loadReviewersData,
  loadSourcesData,
  loadThemesData,
  loadThemeDetail,
  loadEditorSandboxData,
  loadThemeGraphData,
  loadConfigRows,
  parseConfigFlash,
  loadTheme,
  loadAnnotations,
  loadIssueSnippets,
  loadReview,
  loadManageData,
  parseManageFlash,
  isValidTimezone,
  loadReplaysForIssue,
  loadEditorReplaysForIssue,
  loadAdminIssues,
  loadArchive,
  parseFlash,
  loadPromptEditor,
  parseReviewFlash,
} from "./loaders.tsx";

app.notFound((c) => c.html(<NotFoundPage />, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  console.error("[api]", err);
  // Fail safe: never leak stack traces / internal paths to the client by
  // default — a missing or misspelled NODE_ENV in prod must not flip this
  // open. The full error is always on the server console above; set
  // BLURPADURP_DEBUG_ERRORS=1 to also surface it in the browser locally.
  const detail =
    getEnvOptional("BLURPADURP_DEBUG_ERRORS") === "1"
      ? err instanceof Error
        ? err.stack ?? err.message
        : String(err)
      : undefined;
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
