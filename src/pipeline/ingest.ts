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

const DEFAULT_SCOPE = "global";

export async function ingest(): Promise<void> {
  if (connectors.length === 0) {
    console.log("no connectors registered; nothing to ingest");
    return;
  }

  for (const conn of connectors) {
    const scopes = conn.scopes
      ? await Promise.resolve(conn.scopes())
      : [DEFAULT_SCOPE];
    for (const scope of scopes) {
      try {
        await runConnector(conn, scope);
      } catch (err) {
        console.error(`[ingest] ${conn.name}[${scope}] failed:`, err);
      }
    }
  }
}

async function runConnector(conn: Connector, scope: string): Promise<void> {
  const cursor = await loadCursor(conn.name, scope);
  const raws = await conn.fetchSince(cursor);
  const normalized = raws.map((r) => conn.normalize(r));
  const inserted = await upsertStories(normalized);
  await saveCursor(conn.name, scope, new Date());
  console.log(
    `[ingest] ${conn.name}[${scope}]: fetched=${raws.length} inserted=${inserted}`,
  );
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
  await db
    .insertInto("source_cursor")
    .values({
      connector_name,
      scope_key,
      last_seen_at,
      last_seen_id: null,
    })
    .onConflict((oc) =>
      oc.columns(["connector_name", "scope_key"]).doUpdateSet({
        last_seen_at: (eb) => eb.ref("excluded.last_seen_at"),
        last_seen_id: (eb) => eb.ref("excluded.last_seen_id"),
        updated_at: sql`now()`,
      }),
    )
    .execute();
}

async function upsertStories(items: NormalizedStoryInput[]): Promise<number> {
  const rows = items
    .filter((n) => n.source_event_id !== null && n.source_event_id !== "")
    .map((n) => ({
      source_name: n.source_name,
      source_event_id: n.source_event_id,
      source_url: n.source_url,
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
