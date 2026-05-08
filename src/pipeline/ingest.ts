// Pipeline stage: ingest.
// Iterates connectors/registry, fetches new items since each cursor,
// normalizes, upserts into `story`, advances cursor.

import { sql } from "kysely";
import { connectors } from "../connectors/registry.ts";
import type {
  Connector,
  Cursor,
  NormalizedStoryInput,
} from "../connectors/types.ts";
import { db } from "../db/index.ts";
import { withLock } from "../shared/pipeline-lock.ts";
import { reportProgress } from "../shared/pipeline-status.ts";
import { extractHost, loadBlocklist, type Blocklist } from "../shared/source-blocklist.ts";
import {
  classifyUrl,
  loadUrlPathFilters,
  recordFilterHits,
  type UrlPathFilter,
} from "../shared/url-noise.ts";
import {
  classifyTitle,
  loadTitleRegexFilters,
  recordTitleFilterHits,
  type TitleRegexFilter,
} from "../shared/title-noise.ts";

const DEFAULT_SCOPE = "global";

export async function ingest(): Promise<void> {
  await withLock("ingest", 10 * 60_000, runIngest);
}

async function runIngest(): Promise<void> {
  if (connectors.length === 0) {
    console.log("no connectors registered; nothing to ingest");
    return;
  }

  // Load the host blocklist + url path filters once for the whole run
  // — cheap up-front cost vs threading state through every connector.
  // Filters are a snapshot; admin edits take effect on the next run.
  const blocklist = await loadBlocklist();
  if (blocklist.size > 0) {
    console.log(`[ingest] ${blocklist.size} host(s) on blocklist`);
  }
  const pathFilters = await loadUrlPathFilters();
  if (pathFilters.length > 0) {
    const blockN = pathFilters.filter((f) => f.mode === "block").length;
    const tagN = pathFilters.length - blockN;
    console.log(`[ingest] ${blockN} block + ${tagN} tag path filter(s)`);
  }
  const titleFilters = await loadTitleRegexFilters();
  if (titleFilters.length > 0) {
    const blockN = titleFilters.filter((f) => f.mode === "block").length;
    const tagN = titleFilters.length - blockN;
    console.log(`[ingest] ${blockN} block + ${tagN} tag title regex(es)`);
  }
  // Aggregate hits across connectors; written back at end of run.
  const filterHits = new Map<string, number>();
  const titleHits = new Map<string, number>();

  // Pre-compute every (connector, scope) pair so the progress counter is
  // meaningful — scopes() may itself be async (RSS has ~15 feeds).
  const plan: Array<{ conn: Connector; scope: string }> = [];
  for (const conn of connectors) {
    const scopes = conn.scopes
      ? await Promise.resolve(conn.scopes())
      : [DEFAULT_SCOPE];
    for (const scope of scopes) plan.push({ conn, scope });
  }
  console.log(
    `[ingest] ${plan.length} source${plan.length === 1 ? "" : "s"} to pull (${connectors.map((c) => c.name).join(", ")})`,
  );

  const startedAt = Date.now();
  let done = 0;
  let totalFetched = 0;
  let totalInserted = 0;
  await reportProgress("ingest", 0, plan.length, true);
  for (const { conn, scope } of plan) {
    const i = ++done;
    const tag = `(${i}/${plan.length}) ${conn.name}[${scope}]`;
    console.log(`[ingest] ${tag} pulling…`);
    const t0 = Date.now();
    try {
      const { fetched, inserted, blocked, blockedByPath, blockedByTitle, tagged } =
        await runConnector(
          conn,
          scope,
          blocklist,
          pathFilters,
          titleFilters,
          filterHits,
          titleHits,
        );
      totalFetched += fetched;
      totalInserted += inserted;
      const blockSuffix = blocked > 0 ? ` blocked_host=${blocked}` : "";
      const pathSuffix = blockedByPath > 0 ? ` blocked_path=${blockedByPath}` : "";
      const titleSuffix = blockedByTitle > 0 ? ` blocked_title=${blockedByTitle}` : "";
      const tagSuffix = tagged > 0 ? ` tagged=${tagged}` : "";
      console.log(
        `[ingest] ${tag} fetched=${fetched} inserted=${inserted}${blockSuffix}${pathSuffix}${titleSuffix}${tagSuffix} (${Date.now() - t0}ms)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ingest] ${tag} failed: ${msg}`);
      // Persist so /admin/sources can show "gdelt last failed: …"
      // without depending on Fly's log retention.
      await recordRunError(conn.name, scope, msg).catch((e) =>
        console.error(`[ingest] ${tag} error capture failed: ${String(e)}`),
      );
    }
    await reportProgress("ingest", done, plan.length);
  }
  await reportProgress("ingest", done, plan.length, true);
  await recordFilterHits(filterHits);
  await recordTitleFilterHits(titleHits);
  const durSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[ingest] done · ${totalFetched} fetched, ${totalInserted} inserted across ${plan.length} source${plan.length === 1 ? "" : "s"} in ${durSec}s`,
  );
}

async function runConnector(
  conn: Connector,
  scope: string,
  blocklist: Blocklist,
  pathFilters: readonly UrlPathFilter[],
  titleFilters: readonly TitleRegexFilter[],
  filterHits: Map<string, number>,
  titleHits: Map<string, number>,
): Promise<{
  fetched: number;
  inserted: number;
  blocked: number;
  blockedByPath: number;
  blockedByTitle: number;
  tagged: number;
}> {
  const cursor = await loadCursor(conn.name, scope);
  const raws = await conn.fetchSince(cursor);
  const normalized = raws.map((r) => conn.normalize(r));

  // Single classification pass per item:
  //   - blocklisted host        → drop, no embedding/scoring cost
  //   - block-mode path match   → drop
  //   - block-mode title match  → drop
  //   - tag-mode match (either) → persist with the matching column set
  //   - otherwise               → persist clean
  // A story can match both a path filter and a title filter; we record
  // each in its own column. Hits are accumulated for every match (both
  // block and tag) and flushed back to the filter tables at run end.
  let blocked = 0;
  let blockedByPath = 0;
  let blockedByTitle = 0;
  let tagged = 0;
  const allowed: Array<
    NormalizedStoryInput & {
      noise_pattern: string | null;
      noise_title_pattern: string | null;
    }
  > = [];
  for (const n of normalized) {
    const host = extractHost(n.source_url);
    if (host !== null && blocklist.has(host)) {
      blocked++;
      continue;
    }

    let pathPattern: string | null = null;
    const pathMatch = classifyUrl(n.source_url, pathFilters);
    if (pathMatch !== null) {
      filterHits.set(
        pathMatch.pattern,
        (filterHits.get(pathMatch.pattern) ?? 0) + 1,
      );
      if (pathMatch.mode === "block") {
        blockedByPath++;
        continue;
      }
      pathPattern = pathMatch.pattern;
    }

    let titlePattern: string | null = null;
    const titleMatch = classifyTitle(n.title, titleFilters);
    if (titleMatch !== null) {
      titleHits.set(
        titleMatch.pattern,
        (titleHits.get(titleMatch.pattern) ?? 0) + 1,
      );
      if (titleMatch.mode === "block") {
        blockedByTitle++;
        continue;
      }
      titlePattern = titleMatch.pattern;
    }

    if (pathPattern !== null || titlePattern !== null) tagged++;
    allowed.push({
      ...n,
      noise_pattern: pathPattern,
      noise_title_pattern: titlePattern,
    });
  }

  const inserted = await upsertStories(allowed);
  await saveCursor(conn.name, scope, new Date());
  return {
    fetched: raws.length,
    inserted,
    blocked,
    blockedByPath,
    blockedByTitle,
    tagged,
  };
}

async function loadCursor(
  connector_name: string,
  scope_key: string,
): Promise<Cursor> {
  const row = await db
    .selectFrom("source_cursor")
    .where("connector_name", "=", connector_name)
    .where("scope_key", "=", scope_key)
    .select(["last_seen_at", "last_seen_id"])
    .executeTakeFirst();
  return {
    last_seen_at: row?.last_seen_at ?? null,
    last_seen_id: row?.last_seen_id ?? null,
    scope_key,
  };
}

async function saveCursor(
  connector_name: string,
  scope_key: string,
  last_seen_at: Date,
): Promise<void> {
  // Successful run: advance cursor and clear last_error. last_run_at
  // is bumped on every run (success or failure) so "stale connector"
  // is also visible.
  await db
    .insertInto("source_cursor")
    .values({
      connector_name,
      scope_key,
      last_seen_at,
      last_seen_id: null,
      last_error: null,
      last_error_at: null,
      last_run_at: new Date(),
    })
    .onConflict((oc) =>
      oc.columns(["connector_name", "scope_key"]).doUpdateSet({
        last_seen_at: (eb) => eb.ref("excluded.last_seen_at"),
        last_seen_id: (eb) => eb.ref("excluded.last_seen_id"),
        last_error: null,
        last_error_at: null,
        last_run_at: sql`now()`,
        updated_at: sql`now()`,
      }),
    )
    .execute();
}

async function recordRunError(
  connector_name: string,
  scope_key: string,
  error: string,
): Promise<void> {
  // Truncate the error to keep raw_input-style ai_call_log proportions
  // — we want a quick signal in the admin UI, not a stack trace blob.
  const truncated = error.length > 500 ? `${error.slice(0, 500)}…` : error;
  await db
    .insertInto("source_cursor")
    .values({
      connector_name,
      scope_key,
      last_seen_at: null,
      last_seen_id: null,
      last_error: truncated,
      last_error_at: new Date(),
      last_run_at: new Date(),
    })
    .onConflict((oc) =>
      oc.columns(["connector_name", "scope_key"]).doUpdateSet({
        last_error: truncated,
        last_error_at: sql`now()`,
        last_run_at: sql`now()`,
        updated_at: sql`now()`,
      }),
    )
    .execute();
}

async function upsertStories(
  items: Array<
    NormalizedStoryInput & {
      noise_pattern: string | null;
      noise_title_pattern: string | null;
    }
  >,
): Promise<number> {
  const rows = items
    .filter((n) => n.source_event_id !== null && n.source_event_id !== "")
    .map((n) => ({
      source_name: n.source_name,
      source_event_id: n.source_event_id,
      source_url: n.source_url,
      noise_pattern: n.noise_pattern,
      noise_title_pattern: n.noise_title_pattern,
      additional_source_urls: n.additional_source_urls ?? [],
      title: n.title,
      summary: n.summary,
      published_at: n.published_at,
      as_of_date: new Date().toISOString().slice(0, 10),
      has_video: n.has_video ?? false,
      video_url: n.video_url ?? null,
      video_embed_url: n.video_embed_url ?? null,
      video_thumbnail_url: n.video_thumbnail_url ?? null,
      video_duration_sec: n.video_duration_sec ?? null,
      video_caption: n.video_caption ?? null,
    }));

  if (rows.length === 0) return 0;

  // Cross-connector URL dedup: if the URL already exists under a
  // different (source_name, source_event_id), skip inserting — the first
  // connector to claim the URL wins. ON CONFLICT (source_name,
  // source_event_id) only catches within-connector repeats, so this
  // closes the gap.
  const candidateUrls = Array.from(
    new Set(rows.map((r) => r.source_url).filter((u): u is string => !!u)),
  );
  const conflicts =
    candidateUrls.length === 0
      ? []
      : await db
          .selectFrom("story")
          .select(["source_url", "source_name", "source_event_id"])
          .where("source_url", "in", candidateUrls)
          .execute();
  const filtered = rows.filter((r) => {
    if (!r.source_url) return true;
    const match = conflicts.find(
      (c) =>
        c.source_url === r.source_url &&
        (c.source_name !== r.source_name ||
          c.source_event_id !== r.source_event_id),
    );
    return match === undefined;
  });

  if (filtered.length < rows.length) {
    console.log(
      `[ingest] skipping ${rows.length - filtered.length} cross-connector URL dupes`,
    );
  }
  if (filtered.length === 0) return 0;

  // Upsert: re-ingesting the same event refreshes its source URL list
  // and canonical_url (mention counts grow over time).
  const result = await db
    .insertInto("story")
    .values(filtered)
    .onConflict((oc) =>
      oc
        .columns(["source_name", "source_event_id"])
        .where("source_event_id", "is not", null)
        .doUpdateSet({
          source_url: (eb) => eb.ref("excluded.source_url"),
          additional_source_urls: (eb) =>
            eb.ref("excluded.additional_source_urls"),
        }),
    )
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0);
}
