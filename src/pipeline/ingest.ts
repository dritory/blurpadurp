// Pipeline stage: ingest.
// Iterates connectors/registry, fetches new items since each cursor,
// normalizes, upserts into `story`, advances cursor.

import { connectors } from "../connectors/registry.ts";

export async function ingest(): Promise<void> {
  if (connectors.length === 0) {
    console.log("no connectors registered; nothing to ingest");
    return;
  }
  throw new Error("ingest: not implemented");
}
