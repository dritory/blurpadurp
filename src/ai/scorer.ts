// Scorer stage — stub. Wires the prompt (loaded from docs/) through the
// Anthropic SDK, parses with ScorerOutputSchema, logs via logAICall.
//
// Not implemented yet. The interface is fixed; the internals are replaceable
// (model swap, provider swap, tool-augmented deep path) without touching
// callers in src/pipeline/.

import type { AIStage } from "./types.ts";
import type { ScorerInput, ScorerOutput } from "../shared/scoring-schema.ts";

export function makeScorer(config: {
  version: string;
  modelId: string;
  promptPath: string;
}): AIStage<ScorerInput, ScorerOutput> {
  return {
    name: "scorer",
    version: config.version,
    modelId: config.modelId,
    promptPath: config.promptPath,
    run(_input: ScorerInput): Promise<ScorerOutput> {
      throw new Error("scorer.run: not implemented");
    },
  };
}
