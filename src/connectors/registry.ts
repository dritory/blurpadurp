// Source registry. Adding a source = implement the Connector interface
// in a new file and add it here. Nothing else in the pipeline changes.

import type { Connector } from "./types.ts";
import { redditOotl } from "./reddit-ootl.ts";
import { rss } from "./rss.ts";

// GDELT is deregistered: most of its DOC/BigQuery output was tabloid
// wire content, foreign-language noise, and "viral but unverified"
// rumors that we spent calls filtering out. The 16-feed RSS connector
// + Reddit r/OutOfTheLoop covers the editorially-curated zeitgeist
// without the noise. The connector file (./gdelt.ts) is preserved for
// reference / future re-enable; it's not imported here so the BigQuery
// client doesn't try to initialize at boot.
export const connectors: Connector[] = [
  rss,
  redditOotl,
  // wikipediaCurrentEvents,
  // youtubeTrending,
  // knowYourMeme,
  // googleTrends,
];
