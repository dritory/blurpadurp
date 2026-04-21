// Source registry. Adding a source = implement the Connector interface
// in a new file and add it here. Nothing else in the pipeline changes.

import type { Connector } from "./types.ts";
import { gdelt } from "./gdelt.ts";
import { redditOotl } from "./reddit-ootl.ts";
import { rss } from "./rss.ts";

export const connectors: Connector[] = [
  gdelt,
  rss,
  redditOotl,
  // wikipediaCurrentEvents,
  // youtubeTrending,
  // knowYourMeme,
  // googleTrends,
];
