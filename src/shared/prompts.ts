// Unified prompt loader. Two modes:
//
// - live: read the prompt markdown from disk (docs/*-prompt.md). Used
//   by the scheduled pipeline (ingest/score/compose/dispatch). The
//   invariant in CLAUDE.md is that scheduled runs never read the
//   DB-staged prompt_draft — that's admin-only.
//
// - replay: read from prompt_draft if an entry exists for the stage,
//   else fall back to the file. Used by admin re-compose / re-edit
//   actions so the operator can stage a prompt edit and iterate on a
//   draft without shipping through git. The "export to file" admin
//   action writes the staged text back so it can be committed.
//
// extractSystemPrompt pulls the fenced system-prompt block out of the
// markdown. Same format across composer/editor/scorer — so shared.

import { readFile } from "node:fs/promises";

import { db } from "../db/index.ts";

export type PromptStage = "composer" | "editor" | "scorer";
export type PromptMode = "live" | "replay";

export function extractSystemPrompt(raw: string, origin: string): string {
  const re =
    /# System prompt\s+```\s*\n([\s\S]*?)\n```\s*\n\s*# User message template/;
  const m = re.exec(raw);
  if (!m || m[1] === undefined) {
    throw new Error(`${origin}: could not parse system prompt`);
  }
  return m[1];
}

export async function loadRawPrompt(
  stage: PromptStage,
  filePath: string,
  mode: PromptMode,
): Promise<{ raw: string; source: "file" | "staged" }> {
  if (mode === "replay") {
    const staged = await db
      .selectFrom("prompt_draft")
      .select("prompt_md")
      .where("stage", "=", stage)
      .executeTakeFirst();
    if (staged !== undefined) {
      return { raw: staged.prompt_md, source: "staged" };
    }
  }
  const raw = await readFile(filePath, "utf8");
  return { raw, source: "file" };
}

export async function loadSystemPromptText(
  stage: PromptStage,
  filePath: string,
  mode: PromptMode,
): Promise<{ text: string; source: "file" | "staged" }> {
  const { raw, source } = await loadRawPrompt(stage, filePath, mode);
  return { text: extractSystemPrompt(raw, stage), source };
}
