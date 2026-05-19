// OpenAI-compatible chat completions client for the scorer.
//
// Why this exists: cheap providers (DeepSeek, Gemini's compat mode,
// OpenRouter, local vLLM/Ollama) all speak OpenAI's chat-completions
// shape but charge a fraction of Anthropic's rates. The scorer's call
// is structurally simple — one system prompt + one user message + one
// tool call for structured output — so a small custom client beats
// dragging in the OpenAI SDK and lets one code path cover every
// provider that claims OpenAI compatibility.
//
// Auth + endpoint come from env (OPENAI_COMPAT_BASE_URL,
// OPENAI_COMPAT_API_KEY). Flipping providers is an env change, not a
// code change. Set base_url to e.g. https://api.deepseek.com,
// https://generativelanguage.googleapis.com/v1beta/openai, or
// http://nuc.local:11434/v1 for local Ollama.

import { getEnv } from "../shared/env.ts";

export interface OpenAIToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface OpenAICallParams {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  tool: OpenAIToolSchema;
}

export interface OpenAICallResult {
  output: unknown;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read: number | null;
  cache_write: number | null;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      tool_calls?: Array<{
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
      content?: string | null;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    // DeepSeek splits prompt_tokens into hit/miss.
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    // OpenAI / others nest cache info here.
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string; type?: string };
}

export async function callOpenAICompat(
  params: OpenAICallParams,
): Promise<OpenAICallResult> {
  const baseUrl = getEnv("OPENAI_COMPAT_BASE_URL").replace(/\/$/, "");
  const apiKey = getEnv("OPENAI_COMPAT_API_KEY");

  const body = {
    model: params.model,
    messages: [
      { role: "system", content: params.system },
      { role: "user", content: params.user },
    ],
    max_tokens: params.maxTokens,
    temperature: params.temperature,
    tools: [
      {
        type: "function",
        function: {
          name: params.tool.name,
          description: params.tool.description,
          parameters: normalizeSchema(params.tool.parameters),
        },
      },
    ],
    tool_choice: {
      type: "function",
      function: { name: params.tool.name },
    },
  };

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `openai-compat ${resp.status} ${resp.statusText}: ${text.slice(0, 500)}`,
    );
  }

  const json = (await resp.json()) as ChatCompletionResponse;
  if (json.error?.message) {
    throw new Error(`openai-compat error: ${json.error.message}`);
  }

  const message = json.choices?.[0]?.message;
  if (!message) {
    throw new Error("openai-compat: no choices[0].message in response");
  }

  const toolCall = message.tool_calls?.find(
    (t) => t.function?.name === params.tool.name,
  );
  if (!toolCall?.function?.arguments) {
    const preview = JSON.stringify(message).slice(0, 300);
    throw new Error(
      `openai-compat: no tool_call named ${params.tool.name}; got: ${preview}`,
    );
  }

  let output: unknown;
  try {
    output = parseToolArguments(toolCall.function.arguments);
  } catch (e) {
    const args = toolCall.function.arguments;
    // Dump the full bad payload to a tmp file for diagnosis. The error
    // string can't carry the whole thing without making the replay
    // JSONL unreadable; a side-channel file is easier to inspect.
    const dumpPath = `/tmp/openai-compat-bad-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    try {
      await Bun.write(dumpPath, args);
    } catch {
      // best-effort; don't shadow the real error
    }
    const head = args.slice(0, 200);
    const tail = args.slice(-200);
    throw new Error(
      `openai-compat: tool arguments failed JSON parse (${e instanceof Error ? e.message : e}): len=${args.length} dump=${dumpPath} head=${JSON.stringify(head)} tail=${JSON.stringify(tail)}`,
    );
  }

  const usage = json.usage ?? {};
  // Cache accounting varies. DeepSeek: prompt_cache_hit_tokens +
  // prompt_cache_miss_tokens sum to prompt_tokens. OpenAI: nested
  // prompt_tokens_details.cached_tokens, where prompt_tokens is the
  // total. Both expose a "hit" count; we report that as cache_read so
  // the existing 0.1× cache multiplier in estimateCost() applies.
  const cacheHit =
    usage.prompt_cache_hit_tokens ??
    usage.prompt_tokens_details?.cached_tokens ??
    null;
  let tokensIn: number | null;
  if (usage.prompt_cache_miss_tokens !== undefined) {
    tokensIn = usage.prompt_cache_miss_tokens;
  } else if (cacheHit !== null && usage.prompt_tokens !== undefined) {
    tokensIn = Math.max(0, usage.prompt_tokens - cacheHit);
  } else {
    tokensIn = usage.prompt_tokens ?? null;
  }

  return {
    output,
    tokens_in: tokensIn,
    tokens_out: usage.completion_tokens ?? null,
    cache_read: cacheHit,
    cache_write: null,
  };
}

// Best-effort repair for malformed tool-call JSON from OpenAI-compat
// providers. Strict JSON.parse first; if that fails, try a small set
// of known fixups before giving up. Observed quirks:
//
//   * DeepSeek occasionally appends a phantom extra `}` (or `]`),
//     wrapping the response in an unbalanced outer brace. Seen on
//     ~25% of scoring calls. Strip up to 3 trailing closing-brackets
//     and retry.
//   * Some providers emit trailing commas before `}` / `]`. Regex
//     them out before retry.
//
// Each candidate repair is tried in isolation — we don't combine
// fixes silently. If none parse, the caller throws with full
// diagnostic (length, head, tail, dump file).
function parseToolArguments(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch (firstErr) {
    const candidates: string[] = [];
    const trimmed = args.trimEnd();
    // Trailing-comma fix.
    const noTrailingCommas = trimmed.replace(/,(\s*[}\]])/g, "$1");
    if (noTrailingCommas !== trimmed) candidates.push(noTrailingCommas);
    // Strip 1–3 trailing closing brackets (the DeepSeek case).
    let s = trimmed;
    for (let i = 0; i < 3; i++) {
      if (s.endsWith("}") || s.endsWith("]")) {
        s = s.slice(0, -1);
        candidates.push(s);
      } else {
        break;
      }
    }
    for (const c of candidates) {
      try {
        return JSON.parse(c);
      } catch {
        continue;
      }
    }
    throw firstErr;
  }
}

// Some OpenAI-compatible providers (notably strict-mode endpoints, and
// Gemini's compat layer) reject JSON Schema union types like
// `type: ["string", "null"]`. Convert those to `type: "X", nullable: true`
// recursively before sending. This is a no-op on schemas that already
// follow the OpenAPI 3.0 convention.
function normalizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalizeSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const obj = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "type" && Array.isArray(v)) {
      const nonNull = v.filter((t) => t !== "null");
      const hasNull = v.includes("null");
      if (nonNull.length === 1 && hasNull) {
        out["type"] = nonNull[0];
        out["nullable"] = true;
        continue;
      }
    }
    out[k] = normalizeSchema(v);
  }
  return out;
}
