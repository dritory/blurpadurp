// Pipeline stage: score.
// Picks stories needing scoring, runs theme-attach + scorer + gate,
// persists raw_output and denormalized columns.

export async function score(): Promise<void> {
  throw new Error("score: not implemented");
}
