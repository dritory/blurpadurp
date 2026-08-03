// On-demand "checker" — a draft-review aid that runs focused review
// TASKS over a composed brief and reports problems. Advisory and
// operator-triggered from /admin/review; NOT a scheduled pipeline stage
// (nothing in the hourly pipeline depends on it, and it never gates).
//
// Today it runs one task, "gloss": un-glossed acronyms / specialist
// names on first use. The module is structured so a second task is a
// localized add — give it a prompt + tool, validate its output, map it
// into CheckFinding rows tagged with the task id. runChecker fans out
// over the requested tasks and returns the merged, task-tagged findings.
//
// Why an LLM pass at all: the deterministic linter (gloss-lint.ts) is a
// zero-cost recall floor but can't see un-listed specialist names or
// judge gloss adequacy. A focused second pass — whose only job is the
// check — is both more reliable than the composer self-policing in one
// shot and broader than the regex. The deterministic findings are fed in
// as grounding candidates so the model verifies a concrete list rather
// than free-associating, which keeps it stable run-to-run.
//
// Pattern mirrors editor.ts: Anthropic tool-call, cache-on-input-hash so
// a re-click on an unedited draft is free, every call logged.

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { z } from "zod";

import { getEnv } from "../shared/env.ts";
import type {
  CheckDismissal,
  CheckFinding,
  CheckTask,
} from "../shared/check-schema.ts";
import {
  BARE_ACRONYM_WHITELIST,
  type GlossFinding,
} from "../shared/gloss-lint.ts";
import { findCachedOutput, logAICall } from "./log.ts";
import { checkBudget } from "./budget.ts";

const CLIENT = new Anthropic({ apiKey: getEnv("ANTHROPIC_API_KEY") });

// Pinned, like every other AIStage modelId. Cheap + strong at the
// language judgment this needs. Bump CHECKER_VERSION whenever any task
// prompt changes so cache lookups don't serve stale verdicts.
export const CHECKER_MODEL = "claude-haiku-4-5-20251001";
// v2: whitelist rendered from BARE_ACRONYM_WHITELIST instead of being
// re-typed by hand (the two had already drifted), operator ignore list
// honoured, and the model told to return a verdict for every pre-screen
// candidate rather than silently dropping the ones it disagrees with.
export const CHECKER_VERSION = "checker-v2";
const MAX_TOKENS = 2000;

export interface CheckerInput {
  markdown: string;
  // Deterministic gloss-linter findings, used to ground the gloss task.
  glossCandidates: GlossFinding[];
  // Operator ignore list (gloss_term.is_ignored). The linter already
  // drops these; passing them keeps the LLM from re-introducing a term
  // the operator has explicitly waved through.
  ignoredTerms?: string[];
}

export interface CheckerRun {
  findings: CheckFinding[];
  // Pre-screen candidates the model explicitly overruled. Not a problem
  // list — it's what the review page uses to show a regex warning as
  // settled rather than open.
  dismissed: CheckDismissal[];
}

// Run the requested check tasks and return merged, task-tagged findings.
// Defaults to every known task (just "gloss" today).
export async function runChecker(
  input: CheckerInput,
  tasks: CheckTask[] = ["gloss"],
): Promise<CheckerRun> {
  const out: CheckerRun = { findings: [], dismissed: [] };
  for (const task of tasks) {
    if (task === "gloss") {
      const run = await runGlossTask(input);
      out.findings.push(...run.findings);
      out.dismissed.push(...run.dismissed);
    }
  }
  return out;
}

// ── gloss task ──────────────────────────────────────────────────────

// Rendered from the linter's whitelist rather than re-typed, so the two
// layers cannot disagree about what goes bare. They had already drifted
// once, which is how the same term got flagged by one layer and waved
// through by the other on the same page.
const WHITELIST_LINE = [...BARE_ACRONYM_WHITELIST].join(", ");

const GLOSS_SYSTEM = `You are a copy-editor checking one specific rule in a news brief: every unfamiliar acronym AND every specialist name must be glossed — briefly explained — on its FIRST appearance, so a literate non-specialist reader anywhere (Berlin, São Paulo, Nairobi) can follow without pausing to look something up.

These go bare and never need a gloss: ${WHITELIST_LINE}, and ordinary English.

Source credits do not need a gloss either. A term that appears only inside a markdown link label — "[BBC](https://…)", "[AP](https://…)" — is attribution, not prose: the reader is being shown where the claim came from, not asked to understand a term. Never flag one.

Everything else needs context the first time it appears:
- acronyms a general reader may not know: VRA, IRGC, ICC, EMA, OPEC, FDA, IEA, …
- specialist NAMES that aren't acronyms and a regex can't catch: "Brent" (the oil benchmark), "gilt" (UK government bond), "tirzepatide" (a drug), "the Knesset", "Section 122", …

A gloss can take any natural form — a comma clause ("OPEC, the oil-producer cartel"), a parenthetical ("an amicus brief (an outside-party court filing)"), a dash clause ("gilt yields — what the UK pays to borrow —"), or a plain-English substitution ("Iran's elite military force" instead of "the IRGC"). Only the FIRST use must be glossed; later bare uses are correct.

You will receive:
1. The brief (markdown).
2. A regex pre-screen: candidate terms it found and whether it THINKS each is glossed. This pre-screen is mechanical and unreliable — it misses names it doesn't recognise and it misjudges glosses. Treat it as a starting checklist, not the truth: verify each candidate by reading the brief, and ADD any term it missed.

Call the report_gloss_issues tool with ONLY the terms that are NOT adequately glossed on first use — either missing a gloss entirely (severity "missing") or glossed too thinly for a non-specialist (severity "weak"). For each, quote the first-use sentence from the brief and offer a short suggested gloss (≤6 words). If every unfamiliar term is properly glossed on first use, return an empty findings list. Do not flag whitelisted universal acronyms or ordinary words.

Also fill in "dismissed": every pre-screen candidate you decided NOT to flag, with a few words on why (already glossed / universally recognised / source credit). This is what lets the review page reconcile the two layers instead of showing the operator a regex warning you have already overruled. A candidate must appear in exactly one of the two lists.`;

const GLOSS_TOOL = {
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
      dismissed: {
        type: "array",
        description:
          "Pre-screen candidates you are NOT flagging, so the review page can show them as overruled rather than as open warnings.",
        items: {
          type: "object",
          properties: {
            term: { type: "string", description: "The candidate term." },
            reason: {
              type: "string",
              description:
                "A few words: already glossed / universally recognised / source credit / ordinary English.",
            },
          },
          required: ["term"],
        },
      },
    },
    required: ["findings"],
  },
};

// Task-specific output validator (the LLM's raw tool shape).
const GlossToolOutputSchema = z.object({
  findings: z.array(
    z.object({
      term: z.string(),
      kind: z.enum(["acronym", "jargon"]).default("jargon"),
      first_use: z.string(),
      severity: z.enum(["missing", "weak"]),
      suggestion: z.string().default(""),
    }),
  ),
  dismissed: z
    .array(z.object({ term: z.string(), reason: z.string().default("") }))
    .default([]),
});

function renderGlossUserMessage(input: CheckerInput): string {
  const lines: string[] = [];
  lines.push("# Brief", "", input.markdown.trim(), "");
  lines.push("# Regex pre-screen (candidates — verify, don't trust)", "");
  if (input.glossCandidates.length === 0) {
    lines.push(
      "(the regex found no acronyms or listed jargon — but it can't see un-listed specialist names, so still read the brief yourself)",
    );
  } else {
    for (const c of input.glossCandidates) {
      lines.push(
        `- ${c.term} [${c.kind}] — regex thinks ${c.glossed ? "GLOSSED" : "UN-GLOSSED"}; first use: "${c.firstUseSentence}"`,
      );
    }
  }
  const ignored = input.ignoredTerms ?? [];
  if (ignored.length > 0) {
    lines.push(
      "",
      "# Operator ignore list — never flag these, whatever you think",
      "",
      ignored.join(", "),
    );
  }
  lines.push("", "Call report_gloss_issues now.");
  return lines.join("\n");
}

// Exported for testing: the grounding message that feeds the
// deterministic findings to the model as candidates to verify.
export { renderGlossUserMessage };

async function runGlossTask(input: CheckerInput): Promise<CheckerRun> {
  const userMessage = renderGlossUserMessage(input);
  const input_hash = createHash("sha256")
    .update(JSON.stringify({ task: "gloss", system: GLOSS_SYSTEM, userMessage }))
    .digest("hex");

  const cached = await findCachedOutput({
    stage_name: "checker",
    stage_version: CHECKER_VERSION,
    model_id: CHECKER_MODEL,
    input_hash,
  });
  if (cached !== null) {
    const validated = GlossToolOutputSchema.safeParse(cached);
    if (validated.success) return mapGlossRun(validated.data);
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
      model: CHECKER_MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      system: [
        { type: "text", text: GLOSS_SYSTEM, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: userMessage }],
      tools: [GLOSS_TOOL],
      tool_choice: { type: "tool", name: GLOSS_TOOL.name },
    });
    tokens_in = resp.usage?.input_tokens ?? null;
    tokens_out = resp.usage?.output_tokens ?? null;
    cache_read = resp.usage?.cache_read_input_tokens ?? null;
    cache_write = resp.usage?.cache_creation_input_tokens ?? null;
    output = extractToolUse(resp, GLOSS_TOOL.name);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    await logAICall({
      stage_name: "checker",
      stage_version: CHECKER_VERSION,
      model_id: CHECKER_MODEL,
      input_hash,
      input_jsonb: { task: "gloss", ...input },
      output_jsonb: output ?? null,
      tokens_in,
      tokens_out,
      cost_estimate_usd: estimateCost(tokens_in, tokens_out, cache_read, cache_write),
      latency_ms: Date.now() - startedAt,
      error,
    });
  }
  return mapGlossRun(GlossToolOutputSchema.parse(output));
}

function mapGlossRun(out: z.infer<typeof GlossToolOutputSchema>): CheckerRun {
  const findings = out.findings.map((f) => ({
    task: "gloss",
    term: f.term,
    kind: f.kind,
    excerpt: f.first_use,
    severity: f.severity,
    suggestion: f.suggestion,
  }));
  // A term can't be both flagged and dismissed. If the model says both,
  // the flag wins — under-reporting a real gap is the costlier error.
  const flagged = new Set(findings.map((f) => f.term.toLowerCase()));
  const dismissed = out.dismissed
    .filter((d) => !flagged.has(d.term.toLowerCase()))
    .map((d) => ({ task: "gloss", term: d.term, reason: d.reason }));
  return { findings, dismissed };
}

// ── shared plumbing ─────────────────────────────────────────────────

function extractToolUse(resp: Anthropic.Message, toolName: string): unknown {
  const block = resp.content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === "tool_use" && b.name === toolName,
  );
  if (!block) {
    const preview = JSON.stringify(resp.content).slice(0, 200);
    throw new Error(`checker: no tool_use block named ${toolName}; got: ${preview}`);
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
