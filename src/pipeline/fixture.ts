// Fixture / replay harness for the scorer.
//
// Capture:  dump the most recent N scored stories' raw_input + raw_output
//           to JSONL on disk. One live pipeline run feeds many offline
//           prompt iterations from then on.
//
// Replay:   re-score a captured fixture against a different prompt or
//           model, write outputs to a parallel JSONL, and print a diff
//           summary (score deltas, category shifts, gate flips). Does
//           not touch the DB — this is for tuning, not production.
//
// Why this exists: LLM calls cost real money, and the scorer's answer is
// deterministic under (input, prompt, model). Capturing raw_input lets us
// iterate prompts without re-ingesting, and without burning through the
// budget cap every time we change two words.
//
// File format: one JSON object per line (JSONL) — grep-friendly,
// streamable, trivially appendable.

import Anthropic from "@anthropic-ai/sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { db } from "../db/index.ts";
import { getEnv } from "../shared/env.ts";
import {
  ScorerOutputSchema,
  type ScorerInput,
  type ScorerOutput,
} from "../shared/scoring-schema.ts";

const FIXTURES_DIR = "fixtures";
const CLIENT = new Anthropic({ apiKey: getEnv("ANTHROPIC_API_KEY") });

export interface CapturedRow {
  story_id: number;
  title: string;
  source_name: string;
  raw_input: ScorerInput;
  raw_output: ScorerOutput;
  scorer_model_id: string | null;
  scorer_prompt_version: string | null;
  captured_at: string;
}

export interface ReplayRow {
  story_id: number;
  source_prompt_version: string | null;
  source_model_id: string | null;
  replay_prompt_version: string;
  replay_model_id: string;
  captured_output: ScorerOutput;
  replay_output: ScorerOutput | null;
  error: string | null;
  latency_ms: number;
}

export interface ReplaySummary {
  total: number;
  parsed: number;
  errors: number;
  compositeMeanDelta: number;
  categoryShifts: number;
  earlyRejectFlips: number;
  confidenceShifts: number;
  latencyMeanMs: number;
}

export function summarizeReplay(rows: ReplayRow[]): ReplaySummary {
  const ok = rows.filter((r) => r.error === null && r.replay_output !== null);
  return {
    total: rows.length,
    parsed: ok.length,
    errors: rows.length - ok.length,
    compositeMeanDelta: mean(
      ok.map((r) => scoreOf(r.replay_output!) - scoreOf(r.captured_output)),
    ),
    categoryShifts: ok.filter(
      (r) =>
        r.replay_output!.classification.category !==
        r.captured_output.classification.category,
    ).length,
    earlyRejectFlips: ok.filter(
      (r) =>
        r.replay_output!.classification.early_reject !==
        r.captured_output.classification.early_reject,
    ).length,
    confidenceShifts: ok.filter(
      (r) =>
        r.replay_output!.reasoning.point_in_time_confidence !==
        r.captured_output.reasoning.point_in_time_confidence,
    ).length,
    latencyMeanMs: mean(ok.map((r) => r.latency_ms)),
  };
}

export async function captureScorerFixture(limit = 50): Promise<void> {
  const rows = await db
    .selectFrom("story")
    .select([
      "id",
      "title",
      "source_name",
      "raw_input",
      "raw_output",
      "scorer_model_id",
      "scorer_prompt_version",
    ])
    .where("raw_input", "is not", null)
    .where("raw_output", "is not", null)
    .orderBy("scored_at", "desc")
    .limit(limit)
    .execute();

  if (rows.length === 0) {
    console.log("[fixture] no scored stories to capture");
    return;
  }

  await mkdir(FIXTURES_DIR, { recursive: true });
  const stamp = isoStamp();
  const path = resolve(FIXTURES_DIR, `capture-${stamp}.jsonl`);
  const out: string[] = [];
  for (const r of rows) {
    const row: CapturedRow = {
      story_id: Number(r.id),
      title: r.title,
      source_name: r.source_name,
      raw_input: r.raw_input as ScorerInput,
      raw_output: r.raw_output as ScorerOutput,
      scorer_model_id: r.scorer_model_id,
      scorer_prompt_version: r.scorer_prompt_version,
      captured_at: new Date().toISOString(),
    };
    out.push(JSON.stringify(row));
  }
  await writeFile(path, out.join("\n") + "\n", "utf8");
  console.log(`[fixture] captured ${rows.length} rows → ${path}`);
}

export async function replayScorerFixture(params: {
  inputPath: string;
  promptPath: string;
  promptVersion: string;
  modelId: string;
  maxTokens?: number;
}): Promise<void> {
  const raw = await Bun.file(params.inputPath).text();
  const rows: CapturedRow[] = raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as CapturedRow);

  if (rows.length === 0) {
    console.log(`[replay] empty fixture: ${params.inputPath}`);
    return;
  }

  const system = await loadSystemPrompt(params.promptPath);
  const maxTokens = params.maxTokens ?? 2000;
  const replays: ReplayRow[] = [];

  console.log(
    `[replay] ${rows.length} rows · ${params.modelId} · ${params.promptVersion}`,
  );

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const startedAt = Date.now();
    try {
      const userMessage = JSON.stringify(r.raw_input, null, 2);
      const resp = await CLIENT.messages.create({
        model: params.modelId,
        max_tokens: maxTokens,
        temperature: 0,
        system,
        messages: [{ role: "user", content: userMessage }],
      });
      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      const json = extractJsonObject(text);
      const parsed = ScorerOutputSchema.parse(json);
      replays.push({
        story_id: r.story_id,
        source_prompt_version: r.scorer_prompt_version,
        source_model_id: r.scorer_model_id,
        replay_prompt_version: params.promptVersion,
        replay_model_id: params.modelId,
        captured_output: r.raw_output,
        replay_output: parsed,
        error: null,
        latency_ms: Date.now() - startedAt,
      });
    } catch (e) {
      replays.push({
        story_id: r.story_id,
        source_prompt_version: r.scorer_prompt_version,
        source_model_id: r.scorer_model_id,
        replay_prompt_version: params.promptVersion,
        replay_model_id: params.modelId,
        captured_output: r.raw_output,
        replay_output: null,
        error: e instanceof Error ? e.message : String(e),
        latency_ms: Date.now() - startedAt,
      });
    }
    if ((i + 1) % 10 === 0) {
      console.log(`[replay]   ${i + 1}/${rows.length}`);
    }
  }

  const stamp = isoStamp();
  await mkdir(FIXTURES_DIR, { recursive: true });
  const outPath = resolve(FIXTURES_DIR, `replay-${stamp}.jsonl`);
  await writeFile(
    outPath,
    replays.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  );
  console.log(`[replay] wrote ${outPath}`);
  printDiffSummary(replays);
}

function printDiffSummary(rows: ReplayRow[]): void {
  const s = summarizeReplay(rows);
  console.log("");
  console.log("=== diff summary ===");
  console.log(`  parsed:       ${s.parsed}/${s.total}`);
  if (s.errors > 0) console.log(`  errors:       ${s.errors}`);
  if (s.parsed === 0) return;
  const signed = `${s.compositeMeanDelta >= 0 ? "+" : ""}${s.compositeMeanDelta.toFixed(2)}`;
  console.log(`  composite mean Δ:  ${signed}`);
  console.log(`  category shifts:   ${s.categoryShifts}`);
  console.log(`  early-reject flips: ${s.earlyRejectFlips}`);
  console.log(`  confidence shifts: ${s.confidenceShifts}`);
  console.log(`  mean latency:      ${Math.round(s.latencyMeanMs)}ms`);
}

function scoreOf(o: ScorerOutput): number {
  return typeof o.scores.composite === "number" ? o.scores.composite : 0;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function extractJsonObject(text: string): unknown {
  // Accept either a bare JSON object or one wrapped in ```json ... ```.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const payload = fenced?.[1] ?? text;
  const first = payload.indexOf("{");
  const last = payload.lastIndexOf("}");
  if (first < 0 || last < 0 || last < first) {
    throw new Error(`no JSON object in output (first 120 chars): ${text.slice(0, 120)}`);
  }
  return JSON.parse(payload.slice(first, last + 1));
}

async function loadSystemPrompt(path: string): Promise<string> {
  const text = await Bun.file(path).text();
  const m = /# System prompt\s+```\s*\n([\s\S]*?)\n```/.exec(text);
  if (!m || m[1] === undefined) {
    throw new Error(`replay: could not parse system prompt from ${path}`);
  }
  return m[1];
}

function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
