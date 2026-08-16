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
// This module is the single author of the path→key mapping. It writes
// `manifest.json` alongside the pages (src/shared/static-manifest.ts) and
// the Worker resolves requests against that, so there is no second map at
// the edge to keep in sync — there used to be, and it drifted twice.
//
// The render path deliberately reuses the same view components and feed
// renderer as the live routes (src/views/*). The small loaders below
// mirror the ones in src/api/index.tsx — they're duplicated rather than
// imported because index.tsx is the server entrypoint (importing it
// would boot an HTTP listener). If you change a public loader there,
// change it here too; the static-export test guards the shape.

import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

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
import { About } from "../views/about.tsx";
import { Archive, type ArchiveEntry } from "../views/archive.tsx";
import { renderAtomFeed } from "../views/feed.ts";
import { Home } from "../views/home.tsx";
import { IssuePage, type IssueView } from "../views/issue.tsx";
import { Privacy } from "../views/privacy.tsx";
import { LOCALES, LOCALE_PREFIX, type Locale, localizePath } from "../shared/i18n.ts";
import {
  buildManifest,
  HTML_CONTENT_TYPE,
  MANIFEST_KEY,
  type StaticEntry,
  TTL_ASSET,
  TTL_IMMUTABLE,
  TTL_ROLLING,
} from "../shared/static-manifest.ts";

const PUBLIC_URL =
  getEnvOptional("BLURPADURP_PUBLIC_URL") ?? "http://localhost:3000";
const FEED_MAX_ENTRIES = 20;

// Canonical object keys for the rolling pages (the per-issue keys are
// `issues/<id>.html`). The Worker learns these from the manifest.
//
// The default locale keeps the bare keys so nothing at the edge moves;
// other locales are namespaced under their prefix directory, e.g.
// "no/home.html", "no/issues/12.html". `localeKey` is the single place
// that mapping is expressed.
const KEY_HOME = "home.html";
const KEY_ARCHIVE = "archive.html";
const KEY_ABOUT = "about.html";
const KEY_PRIVACY = "privacy.html";
const KEY_FEED = "feed.xml";
const KEY_SITEMAP = "sitemap.xml";
const KEY_ROBOTS = "robots.txt";

/** Object key for a page in a locale. The public path that serves it is
 *  `localizePath(locale, path)`; the two travel together into the
 *  manifest, so neither has to be re-derived at the edge. */
export function localeKey(locale: Locale, key: string): string {
  const prefix = LOCALE_PREFIX[locale];
  return prefix === "" ? key : `${prefix.slice(1)}/${key}`;
}

// The static reader pages reference same-origin sub-resources
// (/assets/blurp.svg, /assets/wave.js, the SVG favicon). If those aren't
// at the edge too, the browser fires them straight at Fly the instant it
// parses the R2-served HTML — waking the machine on every reader visit.
// So we push the whole ./public tree to R2 under `assets/<path>` and list
// each one in the manifest under its /assets/<path> URL.
const ASSET_SOURCE_DIR = "public";
const ASSET_KEY_PREFIX = "assets/";
const ASSET_URL_PREFIX = "/assets/";

// The layout sets an explicit <link rel="icon">, but crawlers and older
// clients still probe /favicon.ico directly — and every miss wakes the
// Fly origin. Alias it onto the SVG mark the pages already link to. The
// manifest is a path→object map, so this is just a second path pointing
// at an object the asset push already wrote.
const FAVICON_PATH = "/favicon.ico";
const FAVICON_ASSET = "blurp.svg";

const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

function assetContentType(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
  return ASSET_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

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
  // One sitemap covering every locale. Each localized URL is listed in
  // its own right — hreflang alternates in the page <head> tell the
  // crawler they're translations of one another, so listing them here
  // is enumeration, not duplication.
  const urls: Array<{ loc: string; lastmod?: string }> = [];
  for (const locale of LOCALES) {
    const at = (path: string) => `${PUBLIC_URL}${localizePath(locale, path)}`;
    urls.push(
      { loc: at("/") },
      { loc: at("/archive") },
      { loc: at("/about") },
      { loc: at("/privacy") },
    );
    for (const iss of issues) {
      urls.push({
        loc: at(`/issue/${iss.id}`),
        lastmod: iss.publishedAt.toISOString().slice(0, 10),
      });
    }
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
  assets: number;
  /** Paths advertised to the edge in the manifest. */
  routes: number;
}

// Each rendered page carries the public path that serves it, its content
// type and its edge TTL, so the manifest can be folded straight out of
// this list rather than re-derived from the keys.
export interface RenderedObject extends StaticEntry {
  body: string;
}

// Pure render: turn the published-issue set into the full list of
// objects the public store should hold. No DB, no store — so it's
// unit-testable with canned rows.
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
    // Feed, sitemap and robots are locale-agnostic — one of each, at
    // the bare key, served from the bare path. The feed carries the
    // brief bodies, which aren't translated, so a per-locale feed would
    // differ only in its own metadata and isn't worth a second surface
    // to keep fresh.
    {
      path: `/${KEY_FEED}`,
      key: KEY_FEED,
      contentType: "application/atom+xml; charset=utf-8",
      ttl: TTL_ROLLING,
      body: renderAtomFeed({
        baseUrl: PUBLIC_URL,
        entries: feedEntries,
        updated: feedUpdated,
      }),
    },
    {
      path: `/${KEY_SITEMAP}`,
      key: KEY_SITEMAP,
      contentType: "application/xml; charset=utf-8",
      ttl: TTL_ROLLING,
      body: buildSitemap(issues),
    },
    {
      path: `/${KEY_ROBOTS}`,
      key: KEY_ROBOTS,
      contentType: "text/plain; charset=utf-8",
      ttl: TTL_ROLLING,
      body: buildRobots(),
    },
  ];
  // Every HTML page, once per locale. The issue set is identical across
  // locales — only the chrome around each brief differs.
  for (const locale of LOCALES) {
    // One helper so the path and the key for a page are written on the
    // same line — they are two halves of one decision, and splitting
    // them is how the edge map drifted in the first place.
    const page = (
      path: string,
      key: string,
      body: string,
      ttl: number = TTL_ROLLING,
    ): RenderedObject => ({
      path: localizePath(locale, path),
      key: localeKey(locale, key),
      contentType: HTML_CONTENT_TYPE,
      ttl,
      body,
    });

    pages.push(
      page(
        "/",
        KEY_HOME,
        await renderNode(<Home home={home} flash={null} locale={locale} />),
      ),
      page(
        "/archive",
        KEY_ARCHIVE,
        await renderNode(
          <Archive issues={issues as ArchiveEntry[]} locale={locale} />,
        ),
      ),
      page("/about", KEY_ABOUT, await renderNode(<About locale={locale} />)),
      page(
        "/privacy",
        KEY_PRIVACY,
        await renderNode(<Privacy locale={locale} />),
      ),
    );
    for (const iss of issues) {
      pages.push(
        page(
          `/issue/${iss.id}`,
          `issues/${iss.id}.html`,
          await renderNode(<IssuePage issue={iss} locale={locale} />),
          // Permalinks are immutable once published.
          TTL_IMMUTABLE,
        ),
      );
    }
  }
  return pages;
}

// Recursively collect every file under a directory (absolute-ish paths
// rooted at the given dir).
async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(full)));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

// Push the ./public tree to the public store under `assets/<path>` so
// the edge Worker can serve /assets/* without ever touching Fly. These
// are deploy-versioned (they change with code, not content), but
// re-uploading the ~2.5 MB tree on each weekly publish is cheap and
// keeps the bucket authoritative.
//
// Returns one manifest entry per file written, so the assets land in the
// manifest by the same route as the pages — the Worker no longer has its
// own /assets/* rule or its own extension→content-type table.
export async function exportPublicAssets(): Promise<StaticEntry[]> {
  let files: string[];
  try {
    files = await listFiles(ASSET_SOURCE_DIR);
  } catch {
    // No ./public (shouldn't happen in prod) — nothing to push.
    return [];
  }
  const store = getPublicObjectStore();
  const entries = await Promise.all(
    files.map(async (file) => {
      const rel = relative(ASSET_SOURCE_DIR, file).split(sep).join("/");
      const contentType = assetContentType(file);
      const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
      await store.put(`${ASSET_KEY_PREFIX}${rel}`, bytes, { contentType });
      return {
        path: `${ASSET_URL_PREFIX}${rel}`,
        key: `${ASSET_KEY_PREFIX}${rel}`,
        contentType,
        ttl: TTL_ASSET,
      };
    }),
  );

  // /favicon.ico is an alias onto an object the loop above already
  // wrote, not a file of its own — so only advertise it if that object
  // actually exists.
  const favicon = entries.find(
    (e) => e.key === `${ASSET_KEY_PREFIX}${FAVICON_ASSET}`,
  );
  if (favicon) {
    entries.push({ ...favicon, path: FAVICON_PATH });
  }
  return entries;
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
  await Promise.all(
    objects.map((o) => store.put(o.key, o.body, { contentType: o.contentType })),
  );
  const assets = await exportPublicAssets();

  // The manifest goes last, on purpose: it's the thing that makes a path
  // servable from the edge, so writing it only after every body is in
  // place means the Worker never resolves a route to an object that
  // isn't there yet. (An R2 miss falls through to the origin, so the
  // worst case was already slow-not-broken — but ordering makes even
  // that window not exist.)
  const manifest = buildManifest([...objects, ...assets], new Date());
  await store.put(MANIFEST_KEY, JSON.stringify(manifest), {
    contentType: "application/json",
  });

  return {
    count: objects.length,
    issues: issues.length,
    assets: assets.length,
    routes: Object.keys(manifest.routes).length,
  };
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
      `static-export: wrote ${res.count} pages (${res.issues} issues) + ${res.assets} assets to the public store, ${res.routes} routes in the manifest`,
    );
  } catch (err) {
    console.error("static-export: export failed (non-fatal)", err);
  }
  // Purge the rolling pages at the edge so the new issue shows
  // immediately instead of waiting out the Worker's short edge TTL.
  // Issue permalinks are immutable, so they don't need purging.
  const rolling: PurgePath[] = [
    "/",
    "/archive",
    "/feed.xml",
    "/sitemap.xml",
    ...LOCALES.filter((l) => LOCALE_PREFIX[l] !== "").flatMap(
      (l) => [localizePath(l, "/"), localizePath(l, "/archive")] as PurgePath[],
    ),
  ];
  try {
    await cdnPurge(rolling);
  } catch (err) {
    console.error("static-export: cdn purge failed (non-fatal)", err);
  }
}
