// Source registry. Adding a source = implement the Connector interface
// in a new file and add it here. Nothing else in the pipeline changes.

import type { Connector } from "./types.ts";
import { gdelt } from "./gdelt.ts";
import { redditOotl } from "./reddit-ootl.ts";
import { rss } from "./rss.ts";

// GDELT brings the regional + multi-language signal that the curated
// RSS feeds can't. It also brings tabloid wire content and foreign-
// language noise — so the source_blocklist table (migration 035) is
// the trim mechanism: hosts get blocked at the ingest boundary and
// never spend embedding/scoring credits. Manage via /admin/sources.
export const connectors: Connector[] = [
  rss,
  redditOotl,
  gdelt,
  // wikipediaCurrentEvents,
  // youtubeTrending,
  // knowYourMeme,
  // googleTrends,
];
