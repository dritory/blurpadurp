// Pipeline stage: dispatch.
// Hourly sweep. For each confirmed email/push subscription, if the
// current hour matches delivery_time_local and there's an unsent issue
// (or an unsent event-driven issue + urgent_override), send it.

export async function dispatch(): Promise<void> {
  throw new Error("dispatch: not implemented");
}
