// Feed + crawler routes (robots.txt, sitemap.xml, feed.xml). Extracted
// from index.tsx (#9).

import type { Hono, } from "hono";

import { db } from "../db/index.ts";
import { servePage } from "../shared/page-cache.ts";
import { getEnvOptional } from "../shared/env.ts";
import { renderAtomFeed } from "../views/feed.ts";
import { PUBLIC_URL } from "./config.ts";

const FEED_MAX_ENTRIES = 20;

export function registerFeedRoutes(app: Hono): void {
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
}
