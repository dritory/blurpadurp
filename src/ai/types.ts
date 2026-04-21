// Every AI stage (scorer, composer, theme classifier, hindsight judge,
// verifier, watchlist) implements this interface. Pipeline calls
// stage.run(input) and logs via logCall().

export interface AIStage<I, O> {
  name: string;              // e.g. "scorer", "composer"
  version: string;           // matches the prompt version in docs/
  modelId: string;           // pinned, e.g. "claude-haiku-4-5-20251001"
  promptPath: string;        // e.g. "docs/scoring-prompt.md"
  run(input: I): Promise<O>;
}

export interface AICallRecord {
  stage_name: string;
  stage_version: string;
  model_id: string;
  input_hash: string | null;
  input_jsonb: unknown;
  output_jsonb: unknown;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_estimate_usd: number | null;
  latency_ms: number;
  error: string | null;
}
