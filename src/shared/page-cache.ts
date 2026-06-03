// Cross-restart cache for the public, slowly-changing read pages
// (homepage, archive, feed, sitemap, issue permalinks). Lives in the
// object store (R2) — NOT in process memory — because the Fly app
// machine autostops/restarts every few minutes, which would wipe an
// in-memory cache and re-query Neon on every cold start. Serving from
// R2 instead lets Neon scale to zero between the weekly publish and
// admin work. See docs/storage.md.
//
// Two layers of safety: a TTL (content changes ~weekly, so an hour of
// staleness is fine) plus an explicit bust when a draft is published
// (publishDraft) so a new issue shows immediately. All store access is
// best-effort — any error falls back to rendering from the DB, so the
// pages work whether or not R2 is configured.

import { getObjectStore } from "./object-store.ts";

const PREFIX = "cache/";
const DEFAULT_TTL_SEC = 3600; // 1h

interface CachedPage {
  builtAt: number;
  body: string;
}

// Serve `key` from the object-store cache when present and fresh,
// otherwise render, store, and return. `render` returning null means
// "not found" — not cached, and the caller should 404.
export async function servePage(
  key: string,
  render: () => Promise<string | null>,
  ttlSec = DEFAULT_TTL_SEC,
): Promise<string | null> {
  const objKey = `${PREFIX}${key}.json`;
  try {
    const blob = await getObjectStore().get(objKey);
    if (blob !== null) {
      const cached = JSON.parse(blob) as CachedPage;
      if (Date.now() - cached.builtAt < ttlSec * 1000) return cached.body;
    }
  } catch {
    // store miss / parse / transport error — fall through to render
  }

  const body = await render();
  if (body === null) return null;

  try {
    await getObjectStore().put(
      objKey,
      JSON.stringify({ builtAt: Date.now(), body } satisfies CachedPage),
    );
  } catch {
    // best-effort — the freshly-rendered body is returned regardless
  }
  return body;
}

// The public pages whose content changes when a new issue is
// published. Issue permalinks (issue-<id>) are immutable once live, so
// they ride their TTL rather than this list.
const PUBLIC_PAGE_KEYS = ["home", "archive", "feed", "sitemap"] as const;

export async function bustPublicPages(): Promise<void> {
  const store = getObjectStore();
  await Promise.all(
    PUBLIC_PAGE_KEYS.map((k) =>
      store.delete(`${PREFIX}${k}.json`).catch(() => {}),
    ),
  );
}
