// Static export: render the public reader pages to the PUBLIC object
// store so the Cloudflare Worker can serve them straight from R2,
// keeping the Fly app (and Neon) out of the read path entirely.
// See docs/scaling.md.
//
// This is the warm counterpart to the lazy R2 page cache in
// page-cache.ts: that one fills on first request (and is busted on
// publish, leaving a cold gap); this one is pushed eagerly at publish
// time so the edge always has a fresh copy with no origin round-trip.
//
// Object keys here MUST match the path→key mapping the Worker uses
// (infra/worker/src/index.ts → keyFor). Keep the two in sync.
//
// The render path deliberately reuses the same view components and feed
// renderer as the live routes (src/views/*). The small loaders below
// mirror the ones in src/api/index.tsx — they're duplicated rather than
// imported because index.tsx is the server entrypoint (importing it
// would boot an HTTP listener). If you change a public loader there,
// change it here too; the static-export test guards the shape.

import { db } from "../db/index.ts";
import { getEnvOptional } from "../shared/env.ts";
import {
  getPublicObjectStore,
  isStaticExportConfigured,
} from "../shared/object-store.ts";
import { cdnPurge, type PurgePath } from "../shared/cdn-purge.ts";
import {
  buildHomeView,
  loadHomeStalenessThresholdDays,
  mapIssueRow,
} from "../shared/issue-loaders.ts";
import { Archive, type ArchiveEntry } from "../views/archive.tsx";
import { renderAtomFeed } from "../views/feed.ts";
import { Home } from "../views/home.tsx";
import { IssuePage, type IssueView } from "../views/issue.tsx";

const PUBLIC_URL =
  getEnvOptional("BLURPADURP_PUBLIC_URL") ?? "http://localhost:3000";
const FEED_MAX_ENTRIES = 20;

// Canonical object keys for the rolling pages (the per-issue keys are
// `issues/<id>.html`). Mirrored in the Worker's keyFor().
const KEY_HOME = "home.html";
const KEY_ARCHIVE = "archive.html";
const KEY_FEED = "feed.xml";
const KEY_SITEMAP = "sitemap.xml";
const KEY_ROBOTS = "robots.txt";

// Render a server JSX node to an HTML string (sync or async tree).
function renderNode(node: unknown): Promise<string> {
  return Promise.resolve(
    (node as { toString(): string | Promise<string> }).toString(),
  ).then(String);
}

// The public reader-page row is exactly an IssueView. Kept as a named
// re-export so the static-export test (and any external caller) has a
// stable type to build fixtures against.
export type IssueRow = IssueView;

async function loadPublishedIssues(): Promise<IssueRow[]> {
  const rows = await db
    .selectFrom("issue")
    .select([
      "id",
      "published_seq",
      "published_at",
      "is_event_driven",
      "title",
      "composed_html",
    ])
    .where("is_draft", "=", false)
    .orderBy("published_at", "desc")
    .execute();
  return rows.map(mapIssueRow);
}

function buildSitemap(issues: IssueRow[]): string {
  const urls: Array<{ loc: string; lastmod?: string }> = [
    { loc: `${PUBLIC_URL}/` },
    { loc: `${PUBLIC_URL}/archive` },
    { loc: `${PUBLIC_URL}/about` },
  ];
  for (const iss of issues) {
    urls.push({
      loc: `${PUBLIC_URL}/issue/${iss.id}`,
      lastmod: iss.publishedAt.toISOString().slice(0, 10),
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
}

function buildRobots(): string {
  // The static surface is only published once the site is public, so
  // the crawler-block stage-2 flag is irrelevant here — always open,
  // pointing at the sitemap. (When BLURPADURP_BLOCK_CRAWLERS is set the
  // operator is pre-launch and the Worker isn't fronting traffic yet.)
  return `User-agent: *\nAllow: /\n\nSitemap: ${PUBLIC_URL}/sitemap.xml\n`;
}

export interface StaticExportResult {
  count: number;
  issues: number;
}

export interface RenderedObject {
  key: string;
  body: string;
}

// Pure render: turn the published-issue set into the full list of
// object key → body pairs the public store should hold. No DB, no store
// — so it's unit-testable with canned rows. Keys mirror the Worker's
// keyFor().
export async function renderStaticSurface(
  issues: IssueRow[],
  thresholdDays: number,
): Promise<RenderedObject[]> {
  const home = buildHomeView(issues[0] ?? null, thresholdDays);
  const feedEntries = issues.slice(0, FEED_MAX_ENTRIES).map((r) => ({
    id: r.id,
    publishedSeq: r.publishedSeq,
    publishedAt: r.publishedAt,
    html: r.html,
    isEventDriven: r.isEventDriven,
    title: r.title,
  }));
  const feedUpdated = issues[0]?.publishedAt ?? new Date();

  const pages: RenderedObject[] = [
    { key: KEY_HOME, body: await renderNode(<Home home={home} flash={null} />) },
    {
      key: KEY_ARCHIVE,
      body: await renderNode(<Archive issues={issues as ArchiveEntry[]} />),
    },
    {
      key: KEY_FEED,
      body: renderAtomFeed({
        baseUrl: PUBLIC_URL,
        entries: feedEntries,
        updated: feedUpdated,
      }),
    },
    { key: KEY_SITEMAP, body: buildSitemap(issues) },
    { key: KEY_ROBOTS, body: buildRobots() },
  ];
  for (const iss of issues) {
    pages.push({
      key: `issues/${iss.id}.html`,
      body: await renderNode(<IssuePage issue={iss} />),
    });
  }
  return pages;
}

// Render every public page and write it to the public object store.
// Always runs against whatever getPublicObjectStore() resolves to (R2
// in prod, fs/memory in dev/test) — the prod gate lives in the publish
// hook (isStaticExportConfigured), not here.
export async function exportStaticPages(): Promise<StaticExportResult> {
  const issues = await loadPublishedIssues();
  const thresholdDays = await loadHomeStalenessThresholdDays();
  const objects = await renderStaticSurface(issues, thresholdDays);
  const store = getPublicObjectStore();
  await Promise.all(objects.map((o) => store.put(o.key, o.body)));
  return { count: objects.length, issues: issues.length };
}

// Publish-hook entry point. No-op in production until R2_PUBLIC_BUCKET
// is set. Best-effort: a failed export or purge must never break the
// publish transaction (which has already committed by the time this
// runs), so everything is swallowed-and-logged.
export async function refreshStaticSurface(): Promise<void> {
  if (!isStaticExportConfigured()) return;
  try {
    const res = await exportStaticPages();
    console.log(
      `static-export: wrote ${res.count} objects (${res.issues} issues) to the public store`,
    );
  } catch (err) {
    console.error("static-export: export failed (non-fatal)", err);
  }
  // Purge the rolling pages at the edge so the new issue shows
  // immediately instead of waiting out the Worker's short edge TTL.
  // Issue permalinks are immutable, so they don't need purging.
  const rolling: PurgePath[] = ["/", "/archive", "/feed.xml", "/sitemap.xml"];
  try {
    await cdnPurge(rolling);
  } catch (err) {
    console.error("static-export: cdn purge failed (non-fatal)", err);
  }
}
