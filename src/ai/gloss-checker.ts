// On-demand LLM gloss-checker. Advisory, operator-triggered from
// /admin/review — NOT a scheduled pipeline stage (it never gates or
// rewrites published output, so it stays clear of the "no new AI stage"
// invariant in the spirit that matters: nothing in the hourly pipeline
// depends on it).
//
// Why it exists: the composer already glosses on first use most of the
// time, but a single generate-everything pass misses one or two terms an
// issue, and the deterministic linter (gloss-lint.ts) can only check a
// hand-maintained jargon list + an acronym regex. A focused second pass
// whose ONLY job is gloss-checking is both more reliable than the
// composer self-policing and broader than the regex — it knows "Brent"
// is oil jargon with no list entry, and it judges gloss adequacy, not
// just punctuation adjacency.
//
// The deterministic findings are passed in as grounding candidates: the
// model verifies a concrete list (and adds what the regex missed) rather
// than free-associating, which keeps it stable run-to-run.
//
// Pattern mirrors editor.ts: Anthropic tool-call, structured output via
// zod, cache-on-input-hash so a re-click on an unedited draft is free,
// every call logged to ai_call_log.

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";

import { getEnv } from "../shared/env.ts";
import {
  GlossCheckOutputSchema,
  type GlossCheckOutput,
} from "../shared/gloss-check-schema.ts";
import type { GlossFinding } from "../shared/gloss-lint.ts";
import { findCachedOutput, logAICall } from "./log.ts";
import { checkBudget } from "./budget.ts";

const CLIENT = new Anthropic({ apiKey: getEnv("ANTHROPIC_API_KEY") });

// Pinned, like every other AIStage modelId. Cheap + strong at the
// language-judgment this needs. Bump the version string below whenever
// the prompt changes so cache lookups don't serve stale verdicts.
export const GLOSS_CHECKER_MODEL = "claude-haiku-4-5-20251001";
export const GLOSS_CHECKER_VERSION = "gloss-checker-v1";
const MAX_TOKENS = 2000;

const SYSTEM_PROMPT = `You are a copy-editor checking one specific rule in a news brief: every unfamiliar acronym AND every specialist name must be glossed — briefly explained — on its FIRST appearance, so a literate non-specialist reader anywhere (Berlin, São Paulo, Nairobi) can follow without pausing to look something up.

These go bare and never need a gloss: US, USA, UK, EU, UN, NATO, AI, FBI, CIA, NASA, CEO, GDP, and ordinary English.

Everything else needs context the first time it appears:
- acronyms a general reader may not know: VRA, IRGC, ICC, EMA, OPEC, FDA, IEA, …
- specialist NAMES that aren't acronyms and a regex can't catch: "Brent" (the oil benchmark), "gilt" (UK government bond), "tirzepatide" (a drug), "the Knesset", "Section 122", …

A gloss can take any natural form — a comma clause ("OPEC, the oil-producer cartel"), a parenthetical ("an amicus brief (an outside-party court filing)"), a dash clause ("gilt yields — what the UK pays to borrow —"), or a plain-English substitution ("Iran's elite military force" instead of "the IRGC"). Only the FIRST use must be glossed; later bare uses are correct.

You will receive:
1. The brief (markdown).
2. A regex pre-screen: candidate terms it found and whether it THINKS each is glossed. This pre-screen is mechanical and unreliable — it misses names it doesn't recognise and it misjudges glosses. Treat it as a starting checklist, not the truth: verify each candidate by reading the brief, and ADD any term it missed.

Call the report_gloss_issues tool with ONLY the terms that are NOT adequately glossed on first use — either missing a gloss entirely (severity "missing") or glossed too thinly for a non-specialist (severity "weak"). For each, quote the first-use sentence from the brief and offer a short suggested gloss (≤6 words). If every unfamiliar term is properly glossed on first use, return an empty findings list. Do not flag whitelisted universal acronyms or ordinary words.`;

const TOOL = {
  name: "report_gloss_issues",
  description:
    "Report terms used un-glossed (or under-glossed) on their first appearance in the brief.",
  input_schema: {
    type: "object" as const,
    properties: {
      findings: {
        type: "array",
        description:
          "Every unfamiliar acronym or specialist name NOT adequately glossed on first use. Empty if the brief is clean.",
        items: {
          type: "object",
          properties: {
            term: {
              type: "string",
              description: "The acronym or name as it appears in the brief.",
            },
            kind: {
              type: "string",
              enum: ["acronym", "jargon"],
              description:
                "'acronym' for an all-caps initialism, 'jargon' for any other specialist word or name.",
            },
            first_use: {
              type: "string",
              description:
                "The first-use sentence or clause, quoted from the brief.",
            },
            severity: {
              type: "string",
              enum: ["missing", "weak"],
              description:
                "'missing' = no gloss at all; 'weak' = present but too thin for a non-specialist.",
            },
            suggestion: {
              type: "string",
              description: "A short proposed gloss (≤6 words), or empty.",
            },
          },
          required: ["term", "first_use", "severity"],
        },
      },
    },
    required: ["findings"],
  },
};

export interface GlossCheckInput {
  markdown: string;
  // Deterministic linter findings, used as grounding candidates.
  candidates: GlossFinding[];
}

// Exported for testing: builds the user message that grounds the model
// on the deterministic findings (candidates to verify, not trust).
export function renderUserMessage(input: GlossCheckInput): string {
  const lines: string[] = [];
  lines.push("# Brief", "", input.markdown.trim(), "");
  lines.push("# Regex pre-screen (candidates — verify, don't trust)", "");
  if (input.candidates.length === 0) {
    lines.push(
      "(the regex found no acronyms or listed jargon — but it can't see un-listed specialist names, so still read the brief yourself)",
    );
  } else {
    for (const c of input.candidates) {
      lines.push(
        `- ${c.term} [${c.kind}] — regex thinks ${c.glossed ? "GLOSSED" : "UN-GLOSSED"}; first use: "${c.firstUseSentence}"`,
      );
    }
  }
  lines.push("", "Call report_gloss_issues now.");
  return lines.join("\n");
}

// Run the gloss-checker. Returns the structured findings; the caller
// wraps them with provenance and persists. Cached on input hash so a
// re-click on an unedited draft costs nothing.
export async function runGlossCheck(
  input: GlossCheckInput,
): Promise<GlossCheckOutput> {
  const userMessage = renderUserMessage(input);
  const input_hash = createHash("sha256")
    .update(JSON.stringify({ system: SYSTEM_PROMPT, userMessage }))
    .digest("hex");

  const cached = await findCachedOutput({
    stage_name: "gloss-checker",
    stage_version: GLOSS_CHECKER_VERSION,
    model_id: GLOSS_CHECKER_MODEL,
    input_hash,
  });
  if (cached !== null) {
    const validated = GlossCheckOutputSchema.safeParse(cached);
    if (validated.success) return validated.data;
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
      model: GLOSS_CHECKER_MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: userMessage }],
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
    });
    tokens_in = resp.usage?.input_tokens ?? null;
    tokens_out = resp.usage?.output_tokens ?? null;
    cache_read = resp.usage?.cache_read_input_tokens ?? null;
    cache_write = resp.usage?.cache_creation_input_tokens ?? null;
    output = extractToolUse(resp, TOOL.name);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    await logAICall({
      stage_name: "gloss-checker",
      stage_version: GLOSS_CHECKER_VERSION,
      model_id: GLOSS_CHECKER_MODEL,
      input_hash,
      input_jsonb: input,
      output_jsonb: output ?? null,
      tokens_in,
      tokens_out,
      cost_estimate_usd: estimateCost(tokens_in, tokens_out, cache_read, cache_write),
      latency_ms: Date.now() - startedAt,
      error,
    });
  }
  return GlossCheckOutputSchema.parse(output);
}

function extractToolUse(resp: Anthropic.Message, toolName: string): unknown {
  const block = resp.content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === "tool_use" && b.name === toolName,
  );
  if (!block) {
    const preview = JSON.stringify(resp.content).slice(0, 200);
    throw new Error(
      `gloss-checker: no tool_use block named ${toolName}; got: ${preview}`,
    );
  }
  return block.input;
}

// Haiku 4.5 pricing (USD per 1M tokens). Keep in step with composer.ts.
const PRICE = { in: 1.0, out: 5.0 };

function estimateCost(
  tokensIn: number | null,
  tokensOut: number | null,
  cacheRead: number | null,
  cacheWrite: number | null,
): number | null {
  if (tokensIn == null || tokensOut == null) return null;
  const inCost =
    tokensIn * PRICE.in +
    (cacheWrite ?? 0) * PRICE.in * 1.25 +
    (cacheRead ?? 0) * PRICE.in * 0.1;
  return (inCost + tokensOut * PRICE.out) / 1_000_000;
}
