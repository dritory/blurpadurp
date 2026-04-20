// Hono app: public archive, subscription endpoints, preference pages.
// No accounts — subscription is the identity. All routes are public.

import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { z } from "zod";

import { db } from "../db/index.ts";
import { getEnvOptional } from "../shared/env.ts";
import { verifyToken } from "../shared/tokens.ts";
import { About } from "../views/about.tsx";
import {
  AdminReview,
  type EditorReviewData,
} from "../views/admin-review.tsx";
import { Archive, type ArchiveEntry } from "../views/archive.tsx";
import { renderAtomFeed } from "../views/feed.ts";
import { Home, type Flash } from "../views/home.tsx";
import { IssuePage, type IssueView } from "../views/issue.tsx";
import { TokenResultPage } from "../views/token-result.tsx";

const PUBLIC_URL =
  getEnvOptional("BLURPADURP_PUBLIC_URL") ?? "http://localhost:3000";
const FEED_MAX_ENTRIES = 20;

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
  return null;
}

// Run directly: `bun run src/api/index.ts`
if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  console.log(`listening on http://localhost:${port}`);
  Bun.serve({ port, fetch: app.fetch });
}
