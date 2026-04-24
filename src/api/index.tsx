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
} from "../views/admin-explore-stories.tsx";
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
  AdminReview,
  type EditorReviewData,
} from "../views/admin-review.tsx";
import {
  AdminThemes,
  type ThemeRow,
  type ThemesData,
  type ThemeFilter,
} from "../views/admin-themes.tsx";
import { Archive, type ArchiveEntry } from "../views/archive.tsx";
import { renderConfirmationEmail } from "../views/email.ts";
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
    return c.html(
      <AdminReview
        data={data}
        replays={replays}
        editorReplays={editorReplays}
      />,
    );
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

  app.get("/admin/themes", async (c) => {
    const filter = parseThemeFilter(c.req.query("filter"));
    const data = await loadThemesData(
      filter,
      parseFlashGeneric(c.req.query("saved"), c.req.query("error")),
    );
    return c.html(<AdminThemes data={data} />);
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
    ? `Confirmed — ${row.email}. You'll get the next issue when the gate fires.`
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

// --- data loaders ---

async function loadLatestIssue(): Promise<IssueView | null> {
  const row = await db
    .selectFrom("issue")
    .select(["id", "published_at", "is_event_driven", "title", "composed_html"])
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
    db.selectFrom("issue").select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow(),
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
  const sort = (["composite", "published", "scored", "ingested"] as const).includes(
    q.sort as SortKey,
  )
    ? (q.sort as SortKey)
    : undefined;
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
  const sortCol =
    sort === "composite"
      ? ("story.composite" as const)
      : sort === "published"
        ? ("story.published_at" as const)
        : sort === "scored"
          ? ("story.scored_at" as const)
          : ("story.ingested_at" as const);

  const rawRows = await q
    .select([
      "story.id",
      "story.title",
      "story.source_name as source",
      "category.slug as category_slug",
      "theme.id as theme_id",
      "theme.name as theme_name",
      "story.composite",
      "story.point_in_time_confidence",
      "story.passed_gate",
      "story.early_reject",
      "story.published_at",
      "story.scored_at",
    ])
    .orderBy(sortCol, "desc")
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

async function loadThemesData(
  filter: ThemeFilter,
  flash: ThemesData["flash"],
): Promise<ThemesData> {
  const totalRow = await db
    .selectFrom("theme")
    .select(sql<string>`count(*)`.as("n"))
    .executeTakeFirstOrThrow();

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

async function loadReview(id: number): Promise<EditorReviewData | null> {
  const iss = await db
    .selectFrom("issue")
    .select([
      "id",
      "published_at",
      "is_event_driven",
      "composer_prompt_version",
      "composer_model_id",
      "story_ids",
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

  return {
    issue: {
      id: Number(iss.id),
      publishedAt: iss.published_at,
      isEventDriven: iss.is_event_driven,
      composerPromptVersion: iss.composer_prompt_version,
      composerModelId: iss.composer_model_id,
    },
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
      "composer_prompt_version",
      "composer_model_id",
      "story_ids",
    ])
    .orderBy("published_at", "desc")
    .execute();
  const replays = await loadReplaysByIssue();
  return rows.map((r) => ({
    id: Number(r.id),
    publishedAt: r.published_at,
    isEventDriven: r.is_event_driven,
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
      msg: "Already confirmed. You'll get the next brief when the gate fires.",
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
  console.log(`listening on http://localhost:${port}`);
  Bun.serve({ port, fetch: app.fetch });
}
