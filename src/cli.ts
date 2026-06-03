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
  "reattach",
  "fixture-capture",
  "fixture-replay",
  "composer-replay",
  "editor-replay",
  "reset-publish",
  "retention",
  "cold-migrate",
  "eval",
  "scheduler-tick",
  "status",
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
    case "reattach":
      await (await import("./pipeline/reattach.ts")).reattach();
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
      const [inputPath, promptPath, promptVersion, modelId, clientArg] = args;
      if (!inputPath || !promptPath || !promptVersion || !modelId) {
        throw new Error(
          "fixture-replay: usage: fixture-replay <input.jsonl> <prompt.md> <version> <model_id> [anthropic|openai_compat]",
        );
      }
      const client = clientArg ?? "anthropic";
      if (client !== "anthropic" && client !== "openai_compat") {
        throw new Error(
          `fixture-replay: client must be "anthropic" or "openai_compat", got: ${client}`,
        );
      }
      const { replayScorerFixture } = await import("./pipeline/fixture.ts");
      await replayScorerFixture({
        inputPath,
        promptPath,
        promptVersion,
        modelId,
        client,
      });
      return;
    }
    case "composer-replay": {
      const [issueIdRaw, promptPath, promptVersion, modelId] = args;
      const issueId = issueIdRaw !== undefined ? Number(issueIdRaw) : undefined;
      if (issueId !== undefined && (!Number.isFinite(issueId) || issueId <= 0)) {
        throw new Error("composer-replay: issue_id must be a positive number");
      }
      const { replayComposer } = await import("./pipeline/fixture.ts");
      await replayComposer({ issueId, promptPath, promptVersion, modelId });
      return;
    }
    case "editor-replay": {
      const [issueIdRaw, promptPath, promptVersion, modelId] = args;
      const issueId = issueIdRaw !== undefined ? Number(issueIdRaw) : undefined;
      if (issueId !== undefined && (!Number.isFinite(issueId) || issueId <= 0)) {
        throw new Error("editor-replay: issue_id must be a positive number");
      }
      const { replayEditor } = await import("./pipeline/fixture.ts");
      await replayEditor({ issueId, promptPath, promptVersion, modelId });
      return;
    }
    case "reset-publish":
      await (await import("./pipeline/reset-publish.ts")).resetPublish();
      return;
    case "retention":
      await (await import("./pipeline/retention.ts")).retention();
      return;
    case "cold-migrate": {
      const batchSize = args[0] !== undefined ? Number(args[0]) : 500;
      const maxBatches = args[1] !== undefined ? Number(args[1]) : 0;
      const olderThanDays = args[2] !== undefined ? Number(args[2]) : 0;
      if (!Number.isFinite(batchSize) || batchSize <= 0) {
        throw new Error("cold-migrate: batchSize must be a positive number");
      }
      if (!Number.isFinite(maxBatches) || maxBatches < 0) {
        throw new Error("cold-migrate: maxBatches must be >= 0");
      }
      if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
        throw new Error("cold-migrate: olderThanDays must be >= 0");
      }
      const { coldMigrate } = await import("./pipeline/cold-migrate.ts");
      await coldMigrate(batchSize, maxBatches, olderThanDays);
      return;
    }
    case "eval":
      await (await import("./pipeline/eval.ts")).evalSummary();
      return;
    case "scheduler-tick":
      await (await import("./scheduler.ts")).runTick();
      return;
    case "status": {
      const { loadStageStatus, loadAllStageStatuses, formatStageStatus } =
        await import("./shared/pipeline-status.ts");
      const stage = args[0];
      if (stage !== undefined) {
        const s = await loadStageStatus(stage);
        console.log(formatStageStatus(s));
        return;
      }
      const all = await loadAllStageStatuses();
      if (all.length === 0) {
        console.log("(no pipeline_run rows yet)");
        return;
      }
      for (const s of all) {
        console.log(formatStageStatus(s));
        console.log("");
      }
      return;
    }
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
