// Pipeline stage: compose.
// Takes stories passing the gate since the last issue, runs the composer
// with prior-theme summaries to avoid repetition, persists an `issue`.

export async function compose(): Promise<void> {
  throw new Error("compose: not implemented");
}
