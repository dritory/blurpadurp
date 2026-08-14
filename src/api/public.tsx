// Public reader + health/status routes. Extracted from index.tsx (#9).

import type { Hono, } from "hono";

import { db } from "../db/index.ts";
import { loadPipelineStatus } from "./status.ts";
import { pageCacheKey, servePage } from "../shared/page-cache.ts";
import { LOCALES, LOCALE_PREFIX } from "../shared/i18n.ts";
import { verifyToken } from "../shared/tokens.ts";
import { About } from "../views/about.tsx";
import { Archive, } from "../views/archive.tsx";
import {
  DraftPreview,
} from "../views/draft-preview.tsx";
import { Privacy } from "../views/privacy.tsx";
import { Home, } from "../views/home.tsx";
import { IssuePage, } from "../views/issue.tsx";
import { SubscribePage } from "../views/subscribe.tsx";
import { ThemePage, } from "../views/theme.tsx";
import {
  loadHome,
  loadIssue,
  loadDraftForPreview,
  parseDraftFlash,
  loadTheme,
  loadAnnotations,
  loadArchive,
  parseFlash,
} from "./loaders.tsx";

export function registerPublicRoutes(app: Hono): void {
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

// Reader pages are registered once per locale: the default locale on
// its bare path (so no existing URL moves) and each other locale under
// its prefix. The handler closes over its locale rather than sniffing
// the path, so a page can't render in one language and link in another.
//
// Locale is NOT negotiated from Accept-Language. These pages are served
// from a shared edge cache keyed on path alone — varying the body by a
// request header behind that cache hands the wrong language to whoever
// asks second. The prefix in the URL is the whole story.
for (const locale of LOCALES) {
  const prefix = LOCALE_PREFIX[locale];
  const root = prefix === "" ? "/" : prefix;

  app.get(root, async (c) => {
    // Served from the R2 page cache (busted on publish) so crawler/reader
    // traffic doesn't wake Neon between weekly issues. See page-cache.ts.
    const body = await servePage(pageCacheKey(locale, "home"), async () => {
      const home = await loadHome();
      return renderHtml(<Home home={home} flash={null} locale={locale} />);
    });
    return c.html(body ?? "", 200, { "Cache-Control": "public, max-age=600" });
  });

  app.get(`${prefix}/subscribe`, (c) => {
    const flash = parseFlash(
      c.req.query("subscribed"),
      c.req.query("error"),
      c.req.query("already"),
      locale,
    );
    return c.html(<SubscribePage flash={flash} locale={locale} />);
  });

  app.get(`${prefix}/archive`, async (c) => {
    const body = await servePage(pageCacheKey(locale, "archive"), async () => {
      const issues = await loadArchive();
      return renderHtml(<Archive issues={issues} locale={locale} />);
    });
    return c.html(body ?? "", 200, { "Cache-Control": "public, max-age=600" });
  });

  app.get(`${prefix}/issue/:id`, async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    // Published issues are immutable, so a longer TTL is safe; recompose
    // is rare and admin-driven.
    const body = await servePage(
      pageCacheKey(locale, `issue-${id}`),
      async () => {
        const issue = await loadIssue(id);
        return issue === null
          ? null
          : renderHtml(<IssuePage issue={issue} locale={locale} />);
      },
      6 * 3600,
    );
    if (body === null) return c.notFound();
    return c.html(body, 200, { "Cache-Control": "public, max-age=3600" });
  });

  app.get(`${prefix}/about`, (c) => c.html(<About locale={locale} />));

  app.get(`${prefix}/privacy`, (c) => c.html(<Privacy locale={locale} />));
}

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

app.get("/theme/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) return c.notFound();
  const data = await loadTheme(id);
  if (data === null) return c.notFound();
  return c.html(<ThemePage data={data} />);
});

// --- admin (basic auth via ADMIN_USER / ADMIN_PASSWORD) ---
}
