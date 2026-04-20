// Theme-continuation confirmation. Called after embedding NN search finds
// a theme neighbor above the similarity threshold — this stage asks an LLM
// whether the new story is actually a continuation of that theme, rather
// than a coincidental vector-space neighbor.

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { z } from "zod";

import { getEnv } from "../shared/env.ts";
import { findCachedOutput, logAICall } from "./log.ts";

const CLIENT = new Anthropic({ apiKey: getEnv("ANTHROPIC_API_KEY") });

export const ThemeConfirmOutputSchema = z.object({
  is_continuation: z.boolean(),
  reasoning: z.string(),
});
export type ThemeConfirmOutput = z.infer<typeof ThemeConfirmOutputSchema>;

export interface ThemeConfirmInput {
  story_title: string;
  story_summary: string | null;
  theme_name: string;
  theme_description: string | null;
  recent_summaries: string[];
  cosine_similarity: number;
}

const SYSTEM = `You decide whether a new news story continues an existing theme.
A theme is a narrow story-arc (a specific ongoing situation, conflict, policy
debate, or scientific development) — NOT a broad topic. "Russia-Ukraine war"
is a theme. "Geopolitics" is not. Output JSON only: { "is_continuation":
boolean, "reasoning": "<one sentence>" }.`;

export async function confirmThemeContinuation(
  input: ThemeConfirmInput,
  modelId = "claude-haiku-4-5-20251001",
): Promise<ThemeConfirmOutput> {
  const user = renderUserMessage(input);
  const input_hash = createHash("sha256")
    .update(JSON.stringify({ system: SYSTEM, user }))
    .digest("hex");

  const cached = await findCachedOutput({
    stage_name: "theme-confirm",
    stage_version: "v0.1",
    model_id: modelId,
    input_hash,
  });
  if (cached !== null) {
    await logAICall({
      stage_name: "theme-confirm",
      stage_version: "v0.1",
      model_id: modelId,
      input_hash,
      input_jsonb: input,
      output_jsonb: cached,
      tokens_in: 0,
      tokens_out: 0,
      cost_estimate_usd: 0,
      latency_ms: 0,
      error: null,
    });
    return ThemeConfirmOutputSchema.parse(cached);
  }

  const startedAt = Date.now();
  let output: unknown;
  let tokens_in: number | null = null;
  let tokens_out: number | null = null;
  let error: string | null = null;

  try {
    const resp = await CLIENT.messages.create({
      model: modelId,
      max_tokens: 200,
      temperature: 0,
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    });
    tokens_in = resp.usage?.input_tokens ?? null;
    tokens_out = resp.usage?.output_tokens ?? null;
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) {
      throw new Error(`theme-confirm: no JSON in response: ${text.slice(0, 200)}`);
    }
    output = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    await logAICall({
      stage_name: "theme-confirm",
      stage_version: "v0.1",
      model_id: modelId,
      input_hash,
      input_jsonb: input,
      output_jsonb: output ?? null,
      tokens_in,
      tokens_out,
      cost_estimate_usd: null,
      latency_ms: Date.now() - startedAt,
      error,
    });
  }
  return ThemeConfirmOutputSchema.parse(output);
}

function renderUserMessage(i: ThemeConfirmInput): string {
  const lines = [
    `new_story:`,
    `  title: ${i.story_title}`,
  ];
  if (i.story_summary) lines.push(`  summary: ${i.story_summary}`);
  lines.push(
    ``,
    `candidate_theme:`,
    `  name: ${i.theme_name}`,
  );
  if (i.theme_description)
    lines.push(`  description: ${i.theme_description}`);
  lines.push(`  cosine_similarity_to_new_story: ${i.cosine_similarity.toFixed(3)}`);
  if (i.recent_summaries.length > 0) {
    lines.push(`  recent_stories:`);
    for (const s of i.recent_summaries) lines.push(`    - ${s}`);
  }
  lines.push(``, `Is the new story a continuation of the candidate theme? JSON only.`);
  return lines.join("\n");
}
