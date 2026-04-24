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

import { makeComposer } from "../ai/composer.ts";
import { makeEditor } from "../ai/editor.ts";
import { db } from "../db/index.ts";
import {
  ComposerInputSchema,
  type ComposerInput,
} from "../shared/composer-schema.ts";
import {
  EditorInputSchema,
  EditorOutputSchema,
  type EditorInput,
  type EditorOutput,
} from "../shared/editor-schema.ts";
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
        r.replay_output!.reasoning.confidence !==
        r.captured_output.reasoning.confidence,
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

// Composer replay: load a persisted issue's composer input from the
// DB and re-render with a different prompt version or model. Writes
// .md and .html to fixtures/ — open locally or via /admin/fixtures.
// Does NOT touch the DB beyond the initial read; the original issue
// stays as it was.
export async function replayComposer(params: {
  issueId?: number;
  promptPath?: string;
  promptVersion?: string;
  modelId?: string;
  maxTokens?: number;
}): Promise<void> {
  // Fill defaults from DB config when args are omitted (zero-arg path).
  let issueId = params.issueId;
  if (issueId === undefined) {
    const latest = await db
      .selectFrom("issue")
      .select("id")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!latest) {
      console.log("[composer-replay] no issues in DB yet — run compose first");
      return;
    }
    issueId = Number(latest.id);
    console.log(`[composer-replay] defaulting to latest issue #${issueId}`);
  }

  const cfgRows = await db
    .selectFrom("config")
    .select(["key", "value"])
    .where("key", "in", [
      "composer.prompt_version",
      "composer.model_id",
      "composer.max_tokens",
    ])
    .execute();
  const cfg = Object.fromEntries(cfgRows.map((r) => [r.key, r.value]));

  const promptVersion =
    params.promptVersion ??
    `${String(cfg["composer.prompt_version"] ?? "dev")}-dev`;
  const modelId =
    params.modelId ?? String(cfg["composer.model_id"] ?? "claude-sonnet-4-6");
  const maxTokens =
    params.maxTokens ?? Number(cfg["composer.max_tokens"] ?? 8000);
  const promptPath = params.promptPath ?? "docs/composer-prompt.md";

  const row = await db
    .selectFrom("issue")
    .select([
      "id",
      "published_at",
      "composer_input_jsonb",
      "composed_markdown",
      "composer_prompt_version",
      "composer_model_id",
    ])
    .where("id", "=", issueId)
    .executeTakeFirst();
  if (!row) {
    console.log(`[composer-replay] issue #${issueId} not found`);
    return;
  }
  if (row.composer_input_jsonb === null) {
    console.log(
      `[composer-replay] issue #${issueId} has no persisted composer_input_jsonb — predates migration 015. Run compose again on fresh data.`,
    );
    return;
  }

  const parsed = ComposerInputSchema.safeParse(row.composer_input_jsonb);
  if (!parsed.success) {
    console.error("[composer-replay] stored input failed schema validation:");
    console.error(parsed.error.issues.slice(0, 5));
    return;
  }
  const input: ComposerInput = parsed.data;

  const composer = makeComposer({
    version: promptVersion,
    modelId,
    promptPath,
    maxTokens,
  });

  console.log(
    `[composer-replay] issue #${row.id} · ${row.composer_prompt_version} (${row.composer_model_id}) → ${promptVersion} (${modelId})`,
  );
  const t0 = Date.now();
  const output = await composer.run(input);
  const latencyMs = Date.now() - t0;

  await mkdir(FIXTURES_DIR, { recursive: true });
  const stamp = isoStamp();
  const base = `composer-replay-i${row.id}-${stamp}`;
  const mdPath = resolve(FIXTURES_DIR, `${base}.md`);
  const htmlPath = resolve(FIXTURES_DIR, `${base}.html`);
  const diffPath = resolve(FIXTURES_DIR, `${base}.diff.md`);
  await writeFile(mdPath, output.markdown, "utf8");
  await writeFile(htmlPath, output.html, "utf8");
  await writeFile(
    diffPath,
    `# composer-replay issue #${row.id}

**Source**: ${row.composer_prompt_version ?? "?"} (${row.composer_model_id ?? "?"})
**Replay**: ${promptVersion} (${modelId})
**Latency**: ${latencyMs}ms
**Original markdown length**: ${row.composed_markdown.length} chars
**Replay markdown length**: ${output.markdown.length} chars

---

## Original

${row.composed_markdown}

---

## Replay

${output.markdown}
`,
    "utf8",
  );
  console.log(
    `[composer-replay] done in ${latencyMs}ms · ${row.composed_markdown.length} → ${output.markdown.length} chars`,
  );
  console.log(`[composer-replay] brief:  /admin/fixtures/${base}.html`);
  console.log(`[composer-replay] diff:   /admin/fixtures/${base}.diff.md`);
}

// Editor replay: mirrors composer-replay but for the pick-selection
// stage. Loads the stored editor_input_jsonb for an issue and re-runs
// the editor with a different prompt/model, writing a .diff.md that the
// side-by-side viewer can render.
export async function replayEditor(params: {
  issueId?: number;
  promptPath?: string;
  promptVersion?: string;
  modelId?: string;
  maxTokens?: number;
}): Promise<void> {
  let issueId = params.issueId;
  if (issueId === undefined) {
    const latest = await db
      .selectFrom("issue")
      .select("id")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!latest) {
      console.log("[editor-replay] no issues in DB yet — run compose first");
      return;
    }
    issueId = Number(latest.id);
    console.log(`[editor-replay] defaulting to latest issue #${issueId}`);
  }

  const cfgRows = await db
    .selectFrom("config")
    .select(["key", "value"])
    .where("key", "in", [
      "editor.prompt_version",
      "editor.model_id",
      "editor.max_tokens",
    ])
    .execute();
  const cfg = Object.fromEntries(cfgRows.map((r) => [r.key, r.value]));

  const promptVersion =
    params.promptVersion ??
    `${String(cfg["editor.prompt_version"] ?? "dev")}-dev`;
  const modelId =
    params.modelId ?? String(cfg["editor.model_id"] ?? "claude-sonnet-4-6");
  const maxTokens =
    params.maxTokens ?? Number(cfg["editor.max_tokens"] ?? 2000);
  const promptPath = params.promptPath ?? "docs/editor-prompt.md";

  const row = await db
    .selectFrom("issue")
    .select([
      "id",
      "published_at",
      "editor_input_jsonb",
      "editor_output_jsonb",
      "composer_prompt_version",
    ])
    .where("id", "=", issueId)
    .executeTakeFirst();
  if (!row) {
    console.log(`[editor-replay] issue #${issueId} not found`);
    return;
  }
  if (row.editor_input_jsonb === null) {
    console.log(
      `[editor-replay] issue #${issueId} has no persisted editor_input_jsonb — predates migration 021. Run compose again on fresh data.`,
    );
    return;
  }

  const parsed = EditorInputSchema.safeParse(row.editor_input_jsonb);
  if (!parsed.success) {
    console.error("[editor-replay] stored input failed schema validation:");
    console.error(parsed.error.issues.slice(0, 5));
    return;
  }
  const input: EditorInput = parsed.data;

  const originalOutput =
    row.editor_output_jsonb !== null
      ? EditorOutputSchema.safeParse(row.editor_output_jsonb)
      : null;

  const editor = makeEditor({
    version: promptVersion,
    modelId,
    promptPath,
    maxTokens,
  });

  console.log(
    `[editor-replay] issue #${row.id} · pool of ${input.stories.length} → ${promptVersion} (${modelId})`,
  );
  const t0 = Date.now();
  const output = await editor.run(input);
  const latencyMs = Date.now() - t0;

  // Build story_id → title lookup so the diff shows human-readable picks
  // instead of bare IDs.
  const titleById = new Map<number, string>(
    input.stories.map((s) => [s.story_id, s.title]),
  );

  await mkdir(FIXTURES_DIR, { recursive: true });
  const stamp = isoStamp();
  const base = `editor-replay-i${row.id}-${stamp}`;
  const jsonPath = resolve(FIXTURES_DIR, `${base}.json`);
  const diffPath = resolve(FIXTURES_DIR, `${base}.diff.md`);
  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        issue_id: Number(row.id),
        replay: {
          prompt_version: promptVersion,
          model_id: modelId,
          latency_ms: latencyMs,
          output,
        },
        original: originalOutput?.success ? originalOutput.data : null,
        input,
      },
      null,
      2,
    ),
    "utf8",
  );

  const originalSection =
    originalOutput !== null && originalOutput.success
      ? renderEditorPicks(originalOutput.data, titleById)
      : "_(original editor output missing or invalid — issue predates editor_output_jsonb or schema changed)_";
  const replaySection = renderEditorPicks(output, titleById);

  await writeFile(
    diffPath,
    `# editor-replay issue #${row.id}

**Source**: editor (${row.composer_prompt_version ?? "?"} era)
**Replay**: ${promptVersion} (${modelId})
**Latency**: ${latencyMs}ms
**Pool size**: ${input.stories.length} stories

---

## Original

${originalSection}

---

## Replay

${replaySection}
`,
    "utf8",
  );
  console.log(
    `[editor-replay] done in ${latencyMs}ms · ${output.picks.length} picks`,
  );
  console.log(`[editor-replay] diff:   /admin/fixtures/${base}.diff.md`);
}

// Render an editor output as a human-readable markdown block: picks in
// rank order (story id, title, reason) plus the cuts summary. Used by
// both sides of the editor-replay diff file.
function renderEditorPicks(
  out: EditorOutput,
  titleById: Map<number, string>,
): string {
  const lines: string[] = [];
  const ranked = [...out.picks].sort((a, b) => a.rank - b.rank);
  for (const p of ranked) {
    if ("story_ids" in p) {
      lines.push(
        `**${p.rank}. arc (${p.story_ids.length} stories, lead #${p.lead_story_id})** — ${p.reason}`,
      );
      for (const sid of p.story_ids) {
        const marker = sid === p.lead_story_id ? "★" : " ";
        lines.push(
          `   ${marker} #${sid} — ${titleById.get(sid) ?? "(unknown title)"}`,
        );
      }
    } else {
      lines.push(
        `**${p.rank}. #${p.story_id}** — ${titleById.get(p.story_id) ?? "(unknown title)"}`,
      );
      lines.push(`   _${p.reason}_`);
    }
    lines.push("");
  }
  lines.push(`**Cuts:** ${out.cuts_summary}`);
  return lines.join("\n");
}
