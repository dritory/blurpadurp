// Scorer stage: loads the prompt from docs/scoring-prompt.md, builds the
// user message from ScorerInput, calls Anthropic, parses with
// ScorerOutputSchema, logs via logAICall. The prompt file's "User message
// template" is documentation; the live format is rendered here in code.

import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { getEnv } from "../shared/env.ts";
import {
  ScorerOutputSchema,
  type ScorerInput,
  type ScorerOutput,
} from "../shared/scoring-schema.ts";
import type { AIStage } from "./types.ts";
import { findCachedOutput, logAICall } from "./log.ts";
import { checkBudget } from "./budget.ts";

const CLIENT = new Anthropic({ apiKey: getEnv("ANTHROPIC_API_KEY") });

const SYSTEM_PROMPT_CACHE = new Map<string, string>();

export function makeScorer(config: {
  version: string;
  modelId: string;
  promptPath: string;
  maxTokens: number;
  temperature: number;
}): AIStage<ScorerInput, ScorerOutput> {
  return {
    name: "scorer",
    version: config.version,
    modelId: config.modelId,
    promptPath: config.promptPath,

    async run(input: ScorerInput): Promise<ScorerOutput> {
      const system = await loadSystemPrompt(config.promptPath);
      const userMessage = renderUserMessage(input);
      const input_hash = hashJson({ system, userMessage });

      const cached = await findCachedOutput({
        stage_name: "scorer",
        stage_version: config.version,
        model_id: config.modelId,
        input_hash,
      });
      if (cached !== null) {
        await logAICall({
          stage_name: "scorer",
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
        return ScorerOutputSchema.parse(cached);
      }

      // Guard against runaway spend. Throws BudgetExceededError if today's
      // accumulated ai_call_log cost has passed config.budget.daily_usd_cap.
      await checkBudget();

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
          temperature: config.temperature,
          system: [
            {
              type: "text",
              text: system,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [{ role: "user", content: userMessage }],
          tools: [SCORER_TOOL],
          tool_choice: { type: "tool", name: SCORER_TOOL.name },
        });
        tokens_in = resp.usage?.input_tokens ?? null;
        tokens_out = resp.usage?.output_tokens ?? null;
        cache_read = resp.usage?.cache_read_input_tokens ?? null;
        cache_write = resp.usage?.cache_creation_input_tokens ?? null;
        output = extractToolUse(resp, SCORER_TOOL.name);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        await logAICall({
          stage_name: "scorer",
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
      return ScorerOutputSchema.parse(output);
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
    throw new Error(`scorer: could not parse system prompt from ${path}`);
  }
  // Replace {{as_of_date}} with a reference to the user message so the
  // system prompt is static across calls and eligible for prompt caching.
  const body = m[1].replaceAll(
    "{{as_of_date}}",
    "the as_of_date provided in the user message",
  );
  SYSTEM_PROMPT_CACHE.set(path, body);
  return body;
}

function renderUserMessage(input: ScorerInput): string {
  const lines: string[] = [];
  lines.push(`as_of_date: ${input.as_of_date}`, "");
  lines.push("story:");
  lines.push(`  title: ${input.story.title}`);
  if (input.story.summary) lines.push(`  summary: ${input.story.summary}`);
  if (input.story.source_url) lines.push(`  source_url: ${input.story.source_url}`);
  if (input.story.published_at)
    lines.push(`  published_at: ${input.story.published_at}`);

  if (input.gdelt_metadata) {
    lines.push("", "gdelt_metadata:");
    for (const [k, v] of Object.entries(input.gdelt_metadata)) {
      if (v !== undefined) lines.push(`  ${k}: ${v}`);
    }
  }

  lines.push("");
  if (input.theme_context) {
    lines.push("theme_context:");
    lines.push(`  theme_name: ${input.theme_context.theme_name}`);
    if (input.theme_context.theme_description)
      lines.push(
        `  theme_description: ${input.theme_context.theme_description}`,
      );
    if (input.theme_context.rolling_composite_avg !== undefined)
      lines.push(
        `  rolling_composite_avg: ${input.theme_context.rolling_composite_avg}`,
      );
    lines.push("  recent_stories (most recent first):");
    for (const s of input.theme_context.recent_stories) {
      const z = s.zeitgeist !== undefined ? `zeitgeist ${s.zeitgeist}` : "";
      lines.push(`    - (${s.date}${z ? ", " + z : ""}) ${s.one_line_summary}`);
    }
  } else {
    lines.push("theme_context: null");
  }

  if (input.viral_signals) {
    lines.push("", "viral_signals:");
    for (const [k, v] of Object.entries(input.viral_signals)) {
      if (v !== undefined && v !== null) lines.push(`  ${k}: ${v}`);
    }
  }

  lines.push("", "Return your JSON object now.");
  return lines.join("\n");
}

// Tool schema mirrors ScorerOutputSchema. The model is told to emit via
// this tool; response arrives as a structured tool_use block, eliminating
// JSON parsing brittleness. Loose where zod coerces (null → default,
// unknown enum → filter); the zod layer still does runtime validation.
const SCORER_TOOL = {
  name: "emit_score",
  description: "Emit the structured score for the provided story.",
  input_schema: {
    type: "object" as const,
    properties: {
      classification: {
        type: "object",
        properties: {
          category: {
            type: ["string", "null"],
            description:
              "One of: politics, science, technology, economy, culture, internet_culture, environment_climate, health, society. Null if none fits.",
          },
          theme_continuation_of: { type: ["string", "null"] },
          early_reject: { type: "boolean" },
          reject_reason: { type: ["string", "null"] },
        },
        required: [
          "category",
          "theme_continuation_of",
          "early_reject",
          "reject_reason",
        ],
      },
      reasoning: {
        type: "object",
        properties: {
          base_rate_per_year: { type: ["number", "null"] },
          retrodiction_12mo: { type: ["string", "null"] },
          steelman_trivial: { type: ["string", "null"] },
          steelman_important: { type: ["string", "null"] },
          factors: {
            type: "object",
            properties: {
              trigger: { type: "array", items: { type: "string" } },
              penalty: { type: "array", items: { type: "string" } },
              uncertainty: { type: "array", items: { type: "string" } },
            },
            required: ["trigger", "penalty", "uncertainty"],
          },
          theme_relationship: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: [
          "base_rate_per_year",
          "retrodiction_12mo",
          "steelman_trivial",
          "steelman_important",
          "factors",
          "theme_relationship",
          "confidence",
        ],
      },
      scores: {
        type: "object",
        properties: {
          zeitgeist: { type: "integer", minimum: 0, maximum: 5 },
          half_life: { type: "integer", minimum: 0, maximum: 5 },
          reach: { type: "integer", minimum: 0, maximum: 5 },
          non_obviousness: { type: "integer", minimum: 0, maximum: 5 },
          structural_importance: { type: "integer", minimum: 0, maximum: 5 },
          composite: { type: "number" },
        },
        required: [
          "zeitgeist",
          "half_life",
          "reach",
          "non_obviousness",
          "structural_importance",
          "composite",
        ],
      },
      summary: { type: ["string", "null"] },
    },
    required: ["classification", "reasoning", "scores", "summary"],
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
      `scorer: no tool_use block named ${toolName} in response; got: ${preview}`,
    );
  }
  return block.input;
}

function hashJson(obj: unknown): string {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

// Approximate USD/1M tokens. Update when Anthropic pricing changes.
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
  // Anthropic pricing: cache write = 1.25× input, cache read = 0.1× input.
  const inCost =
    tokensIn * p.in +
    (cacheWrite ?? 0) * p.in * 1.25 +
    (cacheRead ?? 0) * p.in * 0.1;
  return (inCost + tokensOut * p.out) / 1_000_000;
}
