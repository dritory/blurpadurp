// Voyage AI embeddings. voyage-3.5 is multilingual and 1024-dim by
// default, matching the pgvector schema. Upgrading from voyage-3 (which
// was English-biased) so cross-lingual story deduplication works: the
// same event reported in Albanian/Croatian/Spanish embeds close enough
// to its English coverage for the theme-attach NN search to catch it.
// https://docs.voyageai.com/reference/embeddings-api

import { getEnv } from "../shared/env.ts";

const ENDPOINT = "https://api.voyageai.com/v1/embeddings";
const MODEL = "voyage-3.5";
const MAX_BATCH = 128;

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { total_tokens?: number };
}

export async function embed(
  inputs: string[],
  inputType: "document" | "query" = "document",
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getEnv("VOYAGE_API_KEY")}`,
    },
    body: JSON.stringify({ model: MODEL, input: inputs, input_type: inputType }),
  });
  if (!res.ok) {
    throw new Error(
      `voyage embed failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as VoyageResponse;
  return body.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

export async function embedBatch(
  inputs: string[],
  inputType: "document" | "query" = "document",
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < inputs.length; i += MAX_BATCH) {
    const chunk = inputs.slice(i, i + MAX_BATCH);
    const vecs = await embed(chunk, inputType);
    out.push(...vecs);
  }
  return out;
}

export function toPgVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
