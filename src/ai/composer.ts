// Composer stage: takes gated stories, renders a markdown+html brief via
// Sonnet. Pattern mirrors scorer.ts — prompt loaded from disk, static
// system block with cache_control, structured output via zod.

import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { getEnv } from "../shared/env.ts";
import {
  ComposerOutputSchema,
  type ComposerInput,
  type ComposerOutput,
} from "../shared/composer-schema.ts";
import type { AIStage } from "./types.ts";
import { findCachedOutput, logAICall } from "./log.ts";

const CLIENT = new Anthropic({ apiKey: getEnv("ANTHROPIC_API_KEY") });

const SYSTEM_PROMPT_CACHE = new Map<string, string>();

export function makeComposer(config: {
  version: string;
  modelId: string;
  promptPath: string;
  maxTokens: number;
}): AIStage<ComposerInput, ComposerOutput> {
  return {
    name: "composer",
    version: config.version,
    modelId: config.modelId,
    promptPath: config.promptPath,

    async run(input: ComposerInput): Promise<ComposerOutput> {
      const system = await loadSystemPrompt(config.promptPath);
      const userMessage = renderUserMessage(input);
      const input_hash = createHash("sha256")
        .update(JSON.stringify({ system, userMessage }))
        .digest("hex");

      const cached = await findCachedOutput({
        stage_name: "composer",
        stage_version: config.version,
        model_id: config.modelId,
        input_hash,
      });
      if (cached !== null) {
        await logAICall({
          stage_name: "composer",
          stage_version: config.version,
          model_id: config.modelId,
          input_hash,
          input_jsonb: input,
          output_jsonb: cached,
          tokens_in: 0,
          tokens_out: 0,
          cost_estimate_usd: 0,
          latency_ms: 0,
          error: null,
        });
        return ComposerOutputSchema.parse(cached);
      }

      const startedAt = Date.now();
      let output: unknown;
      let tokens_in: number | null = null;
      let tokens_out: number | null = null;
      let cache_read: number | null = null;
      let cache_write: number | null = null;
      let error: string | null = null;

      try {
        const resp = await CLIENT.messages.create({
          model: config.modelId,
          max_tokens: config.maxTokens,
          temperature: 0.3,
          system: [
            {
              type: "text",
              text: system,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [{ role: "user", content: userMessage }],
          tools: [COMPOSER_TOOL],
          tool_choice: { type: "tool", name: COMPOSER_TOOL.name },
        });
        tokens_in = resp.usage?.input_tokens ?? null;
        tokens_out = resp.usage?.output_tokens ?? null;
        cache_read = resp.usage?.cache_read_input_tokens ?? null;
        cache_write = resp.usage?.cache_creation_input_tokens ?? null;
        output = extractToolUse(resp, COMPOSER_TOOL.name);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        await logAICall({
          stage_name: "composer",
          stage_version: config.version,
          model_id: config.modelId,
          input_hash,
          input_jsonb: input,
          output_jsonb: output ?? null,
          tokens_in,
          tokens_out,
          cost_estimate_usd: estimateCost(
            config.modelId,
            tokens_in,
            tokens_out,
            cache_read,
            cache_write,
          ),
          latency_ms: Date.now() - startedAt,
          error,
        });
      }
      return ComposerOutputSchema.parse(output);
    },
  };
}

async function loadSystemPrompt(path: string): Promise<string> {
  const hit = SYSTEM_PROMPT_CACHE.get(path);
  if (hit !== undefined) return hit;
  const raw = await readFile(path, "utf8");
  const re =
    /# System prompt\s+```\s*\n([\s\S]*?)\n```\s*\n\s*# User message template/;
  const m = re.exec(raw);
  if (!m || m[1] === undefined) {
    throw new Error(`composer: could not parse system prompt from ${path}`);
  }
  const body = m[1];
  SYSTEM_PROMPT_CACHE.set(path, body);
  return body;
}

function renderUserMessage(input: ComposerInput): string {
  const lines: string[] = [];
  lines.push(`week_of: ${input.week_of}`);
  lines.push(`stories_count: ${input.stories.length}`, "");
  lines.push("stories (already gated, ordered by composite score descending):", "");
  for (const s of input.stories) {
    lines.push(`  - story_id: ${s.story_id}`);
    lines.push(`    title: ${s.title}`);
    lines.push(`    summary: ${s.summary ?? "-"}`);
    lines.push(`    source_url: ${s.source_url ?? "-"}`);
    if (s.additional_source_urls.length > 0) {
      lines.push(`    additional_source_urls:`);
      for (const u of s.additional_source_urls) lines.push(`      - ${u}`);
    }
    lines.push(`    category: ${s.category ?? "-"}`);
    lines.push(`    theme: ${s.theme_name ?? "-"}`);
    lines.push(`    theme_relationship: ${s.theme_relationship ?? "-"}`);
    lines.push(`    zeitgeist_score: ${s.zeitgeist_score}`);
    lines.push(`    half_life: ${s.half_life}`);
    lines.push(`    reach: ${s.reach}`);
    lines.push(`    composite: ${s.composite}`);
    lines.push(`    scorer_one_liner: ${s.scorer_one_liner}`);
    lines.push(`    retrodiction_12mo: ${s.retrodiction_12mo}`);
    lines.push("");
  }
  if (input.prior_theme_context.length > 0) {
    lines.push(
      "prior_theme_context (most recent item per theme currently being continued):",
    );
    for (const p of input.prior_theme_context) {
      lines.push(
        `  - theme: ${p.theme_name}; last_published: ${p.last_published}; last_one_liner: ${p.last_one_liner}`,
      );
    }
    lines.push("");
  }
  lines.push("Return your JSON object now.");
  return lines.join("\n");
}

const COMPOSER_TOOL = {
  name: "emit_brief",
  description: "Emit the composed news brief in markdown and HTML.",
  input_schema: {
    type: "object" as const,
    properties: {
      markdown: {
        type: "string",
        description: "Full brief in markdown: headers, bullets, links.",
      },
      html: {
        type: "string",
        description:
          "Same content as HTML, using <h2>, <ul>, <li>, <p>, <a>. No inline styles.",
      },
    },
    required: ["markdown", "html"],
  },
};

function extractToolUse(resp: Anthropic.Message, toolName: string): unknown {
  const block = resp.content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === "tool_use" && b.name === toolName,
  );
  if (!block) {
    const preview = JSON.stringify(resp.content).slice(0, 200);
    throw new Error(
      `composer: no tool_use block named ${toolName} in response; got: ${preview}`,
    );
  }
  return block.input;
}

const PRICING: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5-20251001": { in: 1.0, out: 5.0 },
  "claude-sonnet-4-6": { in: 3.0, out: 15.0 },
  "claude-opus-4-7": { in: 15.0, out: 75.0 },
};

function estimateCost(
  modelId: string,
  tokensIn: number | null,
  tokensOut: number | null,
  cacheRead: number | null,
  cacheWrite: number | null,
): number | null {
  const p = PRICING[modelId];
  if (!p || tokensIn == null || tokensOut == null) return null;
  const inCost =
    tokensIn * p.in +
    (cacheWrite ?? 0) * p.in * 1.25 +
    (cacheRead ?? 0) * p.in * 0.1;
  return (inCost + tokensOut * p.out) / 1_000_000;
}
