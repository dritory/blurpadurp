// Source registry. Adding a source = implement the Connector interface
// in a new file and add it here. Nothing else in the pipeline changes.

import type { Connector } from "./types.ts";
import { gdelt } from "./gdelt.ts";
import { redditOotl } from "./reddit-ootl.ts";
import { rss } from "./rss.ts";
import { wikipedia } from "./wikipedia.ts";

// GDELT brings the regional + multi-language signal that the curated
// RSS feeds can't. It also brings tabloid wire content and foreign-
// language noise — so the source_blocklist table (migration 035) is
// the trim mechanism: hosts get blocked at the ingest boundary and
// never spend embedding/scoring credits. Manage via /admin/sources.
//
// Wikipedia adds two scopes: ITN (small, very high editorial bar) and
// Current Events Portal (broader, daily). Wikipedia editors apply an
// implicit significance filter — being on either surface is itself
// a strong "this matters" signal.
export const connectors: Connector[] = [
  rss,
  redditOotl,
  gdelt,
  wikipedia,
  // youtubeTrending,
  // knowYourMeme,
  // googleTrends,
];
