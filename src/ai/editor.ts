// Editor stage: takes 30–80 gate-passers, returns a 10–15 item shortlist
// with reasons. Curation is fuzzy — we want LLM judgment here, not a sort
// key — so the prompt asks for topic balance, duplicate collapse, and
// under-covered-angle preference. Composer writes from this shortlist.

import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { getEnv } from "../shared/env.ts";
import {
  EditorOutputSchema,
  type EditorInput,
  type EditorOutput,
} from "../shared/editor-schema.ts";
import type { AIStage } from "./types.ts";
import { findCachedOutput, logAICall } from "./log.ts";
import { checkBudget } from "./budget.ts";

const CLIENT = new Anthropic({ apiKey: getEnv("ANTHROPIC_API_KEY") });

const SYSTEM_PROMPT_CACHE = new Map<string, string>();

export function makeEditor(config: {
  version: string;
  modelId: string;
  promptPath: string;
  maxTokens: number;
  /** Pre-extracted system prompt. Overrides the file read — used by
   * the admin replay path so a DB-staged prompt can drive re-edit. */
  systemPromptText?: string;
}): AIStage<EditorInput, EditorOutput> {
  return {
    name: "editor",
    version: config.version,
    modelId: config.modelId,
    promptPath: config.promptPath,

    async run(input: EditorInput): Promise<EditorOutput> {
      const system =
        config.systemPromptText ?? (await loadSystemPrompt(config.promptPath));
      const userMessage = renderUserMessage(input);
      const input_hash = createHash("sha256")
        .update(JSON.stringify({ system, userMessage }))
        .digest("hex");

      const cached = await findCachedOutput({
        stage_name: "editor",
        stage_version: config.version,
        model_id: config.modelId,
        input_hash,
      });
      if (cached !== null) {
        await logAICall({
          stage_name: "editor",
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
        return EditorOutputSchema.parse(cached);
      }

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
          temperature: 0.4,
          system: [
            {
              type: "text",
              text: system,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [{ role: "user", content: userMessage }],
          tools: [EDITOR_TOOL],
          tool_choice: { type: "tool", name: EDITOR_TOOL.name },
        });
        tokens_in = resp.usage?.input_tokens ?? null;
        tokens_out = resp.usage?.output_tokens ?? null;
        cache_read = resp.usage?.cache_read_input_tokens ?? null;
        cache_write = resp.usage?.cache_creation_input_tokens ?? null;
        output = extractToolUse(resp, EDITOR_TOOL.name);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        await logAICall({
          stage_name: "editor",
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
      return EditorOutputSchema.parse(output);
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
    throw new Error(`editor: could not parse system prompt from ${path}`);
  }
  const body = m[1];
  SYSTEM_PROMPT_CACHE.set(path, body);
  return body;
}

function renderUserMessage(input: EditorInput): string {
  const lines: string[] = [];
  lines.push(`as_of_date: ${input.as_of_date}`);
  lines.push(`pool_size: ${input.stories.length}`);
  lines.push(`target_picks: 10-15`, "");

  // Pool composition: the shape the editor is working with. Surfaces
  // the two cohorts where editorial judgment matters most — "quiet
  // but significant" (Worth-knowing candidates) and "loud but
  // insignificant" (stenography trap).
  const pc = input.pool_composition;
  lines.push("pool_composition:");
  const catEntries = Object.entries(pc.by_category)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`);
  lines.push(`  by_category: ${catEntries.join(" ")}`);
  lines.push(
    `  by_confidence: low=${pc.by_confidence.low} medium=${pc.by_confidence.medium} high=${pc.by_confidence.high}`,
  );
  lines.push(
    `  quiet_but_significant (zeitgeist≤2 AND structural≥4) — ${pc.quiet_but_significant.length} stories: [${pc.quiet_but_significant.join(", ")}]`,
  );
  lines.push(
    `    ↑ Worth-knowing candidates. Your bias should be FOR these — they're the consequential stories the feed won't surface.`,
  );
  lines.push(
    `  loud_but_insignificant (zeitgeist≥4 AND structural≤2) — ${pc.loud_but_insignificant.length} stories: [${pc.loud_but_insignificant.join(", ")}]`,
  );
  lines.push(
    `    ↑ Stenography trap. Pick 1–2 max to keep the reader in the loop; more is wire-service reprinting.`,
  );
  lines.push("");

  // Themes digest first — multi-story themes with day_span >= 2 are
  // obvious arc candidates. Gives the model structural visibility into
  // which stories belong together across the week.
  if (input.themes.length > 0) {
    lines.push(
      "themes (pre-grouped by theme; arcs = themes with story_ids.length >= 2 AND day_span >= 2):",
      "",
    );
    for (const t of input.themes) {
      const flags: string[] = [];
      if (t.story_ids.length >= 2 && t.day_span >= 2) flags.push("← arc");
      if (t.is_long_running) flags.push("★ long-running");
      if (t.trajectory === "rising") flags.push("↑ rising");
      if (t.trajectory === "falling") flags.push("↓ falling");
      const tag = flags.length > 0 ? `  ${flags.join(" ")}` : "";
      lines.push(
        `  - theme_id: ${t.theme_id}  "${t.theme_name}"${tag}`,
      );
      lines.push(
        `    category: ${t.category ?? "-"}  n_stories: ${t.story_ids.length}  day_span: ${t.day_span}`,
      );
      lines.push(
        `    story_ids (chronological): [${t.story_ids.join(", ")}]`,
      );
      lines.push(
        `    composite_max: ${t.composite_max}  composite_sum: ${t.composite_sum}  tier1_sources_total: ${t.tier1_sources_total}`,
      );
      if (t.first_published_at !== null) {
        const first = t.first_published_at.slice(0, 10);
        const last = (t.last_published_at ?? t.first_published_at).slice(0, 10);
        lines.push(`    window: ${first} → ${last}`);
      }
      lines.push(
        `    trajectory: ${t.trajectory}  n_prior_publications: ${t.n_prior_publications}  age_days: ${t.age_days}`,
      );
      lines.push("");
    }
  }

  lines.push("stories (ordered by composite score; all have passed the gate):", "");
  for (const s of input.stories) {
    lines.push(`  - story_id: ${s.story_id}`);
    lines.push(`    title: ${s.title}`);
    lines.push(`    category: ${s.category ?? "-"}`);
    lines.push(
      `    theme: ${s.theme_name ?? "-"}${s.theme_id !== null ? ` (id=${s.theme_id})` : ""}`,
    );
    lines.push(`    published_at: ${s.published_at ?? "-"}`);
    lines.push(`    composite: ${s.composite}`);
    lines.push(
      `    zeitgeist: ${s.zeitgeist} half_life: ${s.half_life} reach: ${s.reach} non_obviousness: ${s.non_obviousness}`,
    );
    lines.push(
      `    structural_importance: ${s.structural_importance}  base_rate_per_year: ${s.base_rate_per_year}`,
    );
    lines.push(`    confidence: ${s.confidence ?? "-"}`);
    lines.push(
      `    tier1_sources: ${s.tier1_sources} total_sources: ${s.total_sources}`,
    );
    lines.push(
      `    theme_relationship: ${s.theme_relationship ?? "new_theme"}`,
    );
    lines.push(`    scorer_one_liner: ${s.scorer_one_liner}`);
    if (s.steelman_important.length > 0) {
      lines.push(`    steelman_important: ${s.steelman_important}`);
    }
    lines.push(`    retrodiction_12mo: ${s.retrodiction_12mo}`);
    if (s.factors_trigger.length > 0) {
      lines.push(`    factors.trigger: [${s.factors_trigger.join(", ")}]`);
    }
    if (s.factors_penalty.length > 0) {
      lines.push(`    factors.penalty: [${s.factors_penalty.join(", ")}]`);
    }
    lines.push("");
  }
  lines.push("Return your shortlist now.");
  return lines.join("\n");
}

const EDITOR_TOOL = {
  name: "emit_shortlist",
  description: "Emit the curated shortlist of stories for the issue.",
  input_schema: {
    type: "object" as const,
    properties: {
      picks: {
        type: "array",
        description:
          "Ordered shortlist of 10–15 story_ids with rank and reason.",
        items: {
          type: "object",
          properties: {
            story_id: { type: "integer" },
            rank: {
              type: "integer",
              description:
                "1 = top/headline of the brief, N = closing item.",
            },
            reason: {
              type: "string",
              description: "≤20 words on why this made the cut.",
            },
          },
          required: ["story_id", "rank", "reason"],
        },
      },
      cuts_summary: {
        type: "string",
        description:
          "≤40 words, one sentence on what was cut and why.",
      },
    },
    required: ["picks", "cuts_summary"],
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
      `editor: no tool_use block named ${toolName} in response; got: ${preview}`,
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
