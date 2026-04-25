// Helpers shared by score.ts (post-score embedding refinement) and
// reembed.ts (one-shot backfill). pgvector stores 1024-dim vectors
// as the literal string "[v0,v1,...,v1023]". Read = parse, write =
// reformat via toPgVector in src/ai/embed.ts.

import { db } from "../db/index.ts";
import { toPgVector } from "../ai/embed.ts";

export function parsePgVector(s: string | null): number[] | null {
  if (!s) return null;
  const trimmed = s.replace(/^\[|\]$/g, "");
  if (!trimmed) return null;
  return trimmed.split(",").map(Number);
}

export function averageVectors(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0]!.length;
  const out = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i]! += v[i]!;
  for (let i = 0; i < dim; i++) out[i]! /= vectors.length;
  return out;
}

// Pull every embedded member of a theme, average their embeddings,
// write the result back to theme.centroid_embedding. Called after a
// member story's embedding changes (post-score refinement) or during
// a full reembed pass. No-op when the theme has no embedded members.
export async function recomputeThemeCentroid(themeId: number): Promise<void> {
  const members = await db
    .selectFrom("story")
    .select(["embedding"])
    .where("theme_id", "=", themeId)
    .where("embedding", "is not", null)
    .execute();
  if (members.length === 0) return;
  const vectors = members
    .map((m) => parsePgVector(m.embedding))
    .filter((v): v is number[] => v !== null);
  if (vectors.length === 0) return;
  const mean = averageVectors(vectors);
  await db
    .updateTable("theme")
    .set({ centroid_embedding: toPgVector(mean) })
    .where("id", "=", themeId)
    .execute();
}

// The text we embed determines clustering quality. For scored stories
// the scorer's `summary` is the highest-signal input we have:
// language-normalized, event-focused, consistent across outlets.
// Falls back to the story's raw summary, then to title alone.
export function embeddingTextForStory(story: {
  title: string;
  summary: string | null;
  raw_output: unknown;
}): string {
  const scorerSummary = readScorerSummary(story.raw_output);
  const body = scorerSummary ?? story.summary ?? "";
  return `${story.title}\n\n${body}`.trim();
}

function readScorerSummary(rawOutput: unknown): string | null {
  if (rawOutput === null || typeof rawOutput !== "object") return null;
  const r = rawOutput as { summary?: unknown; one_line_summary?: unknown };
  // v0.2 scorer prompt: `summary`. v0.1: `one_line_summary`.
  const candidate =
    typeof r.summary === "string" && r.summary.trim() !== ""
      ? r.summary
      : typeof r.one_line_summary === "string" && r.one_line_summary.trim() !== ""
        ? r.one_line_summary
        : null;
  return candidate !== null ? candidate.trim() : null;
}
