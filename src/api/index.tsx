// Hono app: public archive, subscription endpoints, preference pages.
// No accounts — subscription is the identity. All routes are public.

import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
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
import { getEnvOptional } from "../shared/env.ts";
import { clientIp, makeRateLimiter } from "../shared/rate-limit.ts";
import { verifyToken } from "../shared/tokens.ts";
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
  AdminCaptureView,
  AdminFixturesList,
  AdminReplayView,
  type FixtureFile,
} from "../views/admin-fixtures.tsx";
import {
  AdminReview,
  type EditorReviewData,
} from "../views/admin-review.tsx";
import { Archive, type ArchiveEntry } from "../views/archive.tsx";
import { renderAtomFeed } from "../views/feed.ts";
import { Home, type Flash } from "../views/home.tsx";
import { IssuePage, type IssueView } from "../views/issue.tsx";
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

app.get("/health", (c) => c.json({ ok: true }));

app.get("/", async (c) => {
  const latest = await loadLatestIssue();
  const flash = parseFlash(c.req.query("subscribed"), c.req.query("error"));
  return c.html(<Home latest={latest} flash={flash} />);
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

  app.get("/admin/review/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const data = await loadReview(id);
    if (data === null) return c.notFound();
    return c.html(<AdminReview data={data} />);
  });

  app.get("/admin/costs", async (c) => {
    const data = await loadCostData();
    return c.html(<AdminCosts data={data} />);
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
    const text = await Bun.file(path)
      .text()
      .catch(() => null);
    if (text === null) return c.notFound();
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
      return c.html(
        <AdminCaptureView name={name} rows={rows as CapturedRow[]} />,
      );
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
      `/admin/config?saved=1&key=${encodeURIComponent(key)}`,
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
    .select(["id", "published_at", "is_event_driven", "composed_html"])
    .orderBy("published_at", "desc")
    .limit(FEED_MAX_ENTRIES)
    .execute();
  const entries = rows.map((r) => ({
    id: Number(r.id),
    publishedAt: r.published_at,
    html: r.composed_html,
    isEventDriven: r.is_event_driven,
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
    return c.redirect("/?error=rate_limited", 303);
  }
  const body = await c.req.parseBody();
  // Honeypot: bots fill every field; humans leave this hidden one empty.
  // Silently redirect as if it succeeded — no signal to the bot.
  if (typeof body.company === "string" && body.company.length > 0) {
    return c.redirect("/?subscribed=1", 303);
  }
  const parsed = SubscribeSchema.safeParse({ email: body.email });
  if (!parsed.success) {
    return c.redirect("/?error=invalid_email", 303);
  }
  await db
    .insertInto("email_subscription")
    .values({ email: parsed.data.email })
    .onConflict((oc) => oc.column("email").doNothing())
    .execute();
  return c.redirect("/?subscribed=1", 303);
});

// --- data loaders ---

async function loadLatestIssue(): Promise<IssueView | null> {
  const row = await db
    .selectFrom("issue")
    .select(["id", "published_at", "is_event_driven", "composed_html"])
    .orderBy("published_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: Number(row.id),
    publishedAt: row.published_at,
    isEventDriven: row.is_event_driven,
    html: row.composed_html,
  };
}

async function loadIssue(id: number): Promise<IssueView | null> {
  const row = await db
    .selectFrom("issue")
    .select(["id", "published_at", "is_event_driven", "composed_html"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: Number(row.id),
    publishedAt: row.published_at,
    isEventDriven: row.is_event_driven,
    html: row.composed_html,
  };
}

async function listFixtures(): Promise<FixtureFile[]> {
  const dir = resolve("fixtures");
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: FixtureFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const st = await stat(resolve(dir, name)).catch(() => null);
    if (st === null) continue;
    const kind: FixtureFile["kind"] = name.startsWith("capture-")
      ? "capture"
      : name.startsWith("replay-")
        ? "replay"
        : "unknown";
    out.push({
      name,
      sizeBytes: st.size,
      mtime: st.mtime,
      kind,
    });
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
): { kind: "ok" | "error"; msg: string } | null {
  const label = key !== undefined && key.length > 0 ? ` (${key})` : "";
  if (saved) return { kind: "ok", msg: `Saved${label}.` };
  if (error === "bad_json") {
    return { kind: "error", msg: `Value is not valid JSON${label}.` };
  }
  if (error === "unknown_key") {
    return { kind: "error", msg: `Unknown config key${label}.` };
  }
  if (error === "missing_key") {
    return { kind: "error", msg: "Missing key in form submission." };
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
        .select(["id", "title"])
        .where("id", "in", storyIds)
        .execute()
    : [];
  const storyTitles = new Map<number, string>(
    titleRows.map((r) => [Number(r.id), r.title]),
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
    shrug: (iss.shrug_candidates_jsonb as EditorReviewData["shrug"]) ?? [],
  };
}

async function loadArchive(): Promise<ArchiveEntry[]> {
  const rows = await db
    .selectFrom("issue")
    .select(["id", "published_at", "is_event_driven"])
    .orderBy("published_at", "desc")
    .execute();
  return rows.map((r) => ({
    id: Number(r.id),
    publishedAt: r.published_at,
    isEventDriven: r.is_event_driven,
  }));
}

function parseFlash(
  subscribed: string | undefined,
  error: string | undefined,
): Flash {
  if (subscribed) {
    return {
      kind: "ok",
      msg: "Subscribed. You'll get the next issue when the gate fires.",
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

// Run directly: `bun run src/api/index.ts`
if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  console.log(`listening on http://localhost:${port}`);
  Bun.serve({ port, fetch: app.fetch });
}
