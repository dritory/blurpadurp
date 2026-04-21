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
  "urgent",
  "reembed",
  "retag",
  "fixture-capture",
  "fixture-replay",
  "eval",
] as const;

type Sub = (typeof SUBCOMMANDS)[number];

async function run(sub: Sub, args: string[]): Promise<void> {
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
    case "urgent":
      await (await import("./pipeline/urgent.ts")).urgent();
      return;
    case "reembed":
      await (await import("./pipeline/reembed.ts")).reembed();
      return;
    case "retag":
      await (await import("./pipeline/retag.ts")).retag();
      return;
    case "fixture-capture": {
      const limit = args[0] !== undefined ? Number(args[0]) : 50;
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new Error("fixture-capture: limit must be a positive number");
      }
      const { captureScorerFixture } = await import("./pipeline/fixture.ts");
      await captureScorerFixture(limit);
      return;
    }
    case "fixture-replay": {
      const [inputPath, promptPath, promptVersion, modelId] = args;
      if (!inputPath || !promptPath || !promptVersion || !modelId) {
        throw new Error(
          "fixture-replay: usage: fixture-replay <input.jsonl> <prompt.md> <version> <model_id>",
        );
      }
      const { replayScorerFixture } = await import("./pipeline/fixture.ts");
      await replayScorerFixture({
        inputPath,
        promptPath,
        promptVersion,
        modelId,
      });
      return;
    }
    case "eval":
      await (await import("./pipeline/eval.ts")).evalSummary();
      return;
  }
}

const sub = process.argv[2];
const args = process.argv.slice(3);
if (!sub || !SUBCOMMANDS.includes(sub as Sub)) {
  console.error(`usage: bun run src/cli.ts <${SUBCOMMANDS.join("|")}>`);
  process.exit(1);
}

try {
  await run(sub as Sub, args);
} catch (err) {
  console.error(err);
  process.exit(1);
} finally {
  await closeDb();
}
