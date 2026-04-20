#!/usr/bin/env bun
// Single CLI entry point. Subcommands map 1:1 to pipeline stages
// plus the migrator. Each subcommand loads lazily so `migrate` has
// no transitive imports beyond the DB layer.

import { closeDb } from "./db/index.ts";

const SUBCOMMANDS = [
  "migrate",
  "ingest",
  "score",
  "compose",
  "dispatch",
  "reembed",
  "retag",
] as const;

type Sub = (typeof SUBCOMMANDS)[number];

async function run(sub: Sub): Promise<void> {
  switch (sub) {
    case "migrate":
      await (await import("./db/migrate.ts")).runMigrations();
      return;
    case "ingest":
      await (await import("./pipeline/ingest.ts")).ingest();
      return;
    case "score":
      await (await import("./pipeline/score.ts")).score();
      return;
    case "compose":
      await (await import("./pipeline/compose.ts")).compose();
      return;
    case "dispatch":
      await (await import("./pipeline/dispatch.ts")).dispatch();
      return;
    case "reembed":
      await (await import("./pipeline/reembed.ts")).reembed();
      return;
    case "retag":
      await (await import("./pipeline/retag.ts")).retag();
      return;
  }
}

const sub = process.argv[2];
if (!sub || !SUBCOMMANDS.includes(sub as Sub)) {
  console.error(`usage: bun run src/cli.ts <${SUBCOMMANDS.join("|")}>`);
  process.exit(1);
}

try {
  await run(sub as Sub);
} catch (err) {
  console.error(err);
  process.exit(1);
} finally {
  await closeDb();
}
