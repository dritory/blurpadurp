// Pure budget-guard logic, deliberately free of any DB import so it stays
// unit-testable in isolation. The DB-backed orchestration lives in
// budget.ts (checkBudget), which sums spend and delegates the threshold
// decision here.

export class BudgetExceededError extends Error {
  constructor(
    public readonly spentUsd: number,
    public readonly capUsd: number,
  ) {
    super(
      `daily budget cap exceeded: spent $${spentUsd.toFixed(2)} / cap $${capUsd.toFixed(2)}`,
    );
    this.name = "BudgetExceededError";
  }
}

// A null cap means the guard is disabled (no config). The comparison is
// `>=` so spend exactly at the cap trips it — the cap is a ceiling, not a
// target.
export function assertWithinBudget(spentUsd: number, cap: number | null): void {
  if (cap === null) return;
  if (spentUsd >= cap) throw new BudgetExceededError(spentUsd, cap);
}

export function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}
