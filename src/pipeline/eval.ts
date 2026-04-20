// Eval summary: compares hand-labeled verdicts against the scorer's
// composite + gate decision, reports precision / recall at varying X
// thresholds, and surfaces worst misses (high composite + "no", low
// composite + "yes").
//
// "yes" is treated as the positive class. "no" is the negative. "maybe"
// is ambiguous — counted in the denominators but never counted as a
// hit or miss (see honest-accuracy note below). "skip" is excluded
// entirely.

import { db } from "../db/index.ts";

interface LabeledRow {
  story_id: number;
  title: string;
  label: "yes" | "maybe" | "no" | "skip";
  composite: number | null;
  passed_gate: boolean;
}

export async function evalSummary(): Promise<void> {
  const rows: LabeledRow[] = (
    await db
      .selectFrom("eval_label")
      .innerJoin("story", "story.id", "eval_label.story_id")
      .select([
        "story.id as story_id",
        "story.title",
        "eval_label.label",
        "story.composite",
        "story.passed_gate",
      ])
      .execute()
  ).map((r) => ({
    story_id: Number(r.story_id),
    title: r.title,
    label: r.label,
    composite: r.composite !== null ? Number(r.composite) : null,
    passed_gate: r.passed_gate,
  }));

  if (rows.length === 0) {
    console.log(
      "[eval] no labeled rows yet. Label stories at /admin/eval first.",
    );
    return;
  }

  const byLabel: Record<string, number> = {};
  for (const r of rows) byLabel[r.label] = (byLabel[r.label] ?? 0) + 1;
  console.log(`[eval] ${rows.length} labeled rows:`);
  for (const [k, v] of Object.entries(byLabel)) console.log(`  ${k}: ${v}`);

  // Current gate: scored by the existing config.gate.x_threshold; use
  // passed_gate as-scored. Precision = yes among passers; recall = passers
  // among yes.
  const passers = rows.filter((r) => r.passed_gate);
  const yesses = rows.filter((r) => r.label === "yes");
  const tp = passers.filter((r) => r.label === "yes").length;
  const fp = passers.filter((r) => r.label === "no").length;
  const fn = yesses.filter((r) => !r.passed_gate).length;
  const precision = passers.length > 0 ? tp / passers.length : 0;
  const recall = yesses.length > 0 ? tp / yesses.length : 0;
  console.log(`\n[eval] current gate:`);
  console.log(`  passers:  ${passers.length}`);
  console.log(`  yes:      ${yesses.length}`);
  console.log(`  TP:       ${tp}`);
  console.log(`  FP:       ${fp}  (would be false alarm)`);
  console.log(`  FN:       ${fn}  (would be missed)`);
  console.log(`  precision: ${(precision * 100).toFixed(1)}%`);
  console.log(`  recall:    ${(recall * 100).toFixed(1)}%`);

  // Sweep across candidate composite thresholds to see how precision /
  // recall would shift under a different gate.
  console.log(`\n[eval] composite threshold sweep (non-null composites only):`);
  const compositesPresent = rows.filter((r) => r.composite !== null);
  const thresholds = [4, 6, 8, 10, 12, 15, 18, 20];
  console.log("  X     P=pass  TP   FP   FN   prec    recall");
  for (const x of thresholds) {
    const p = compositesPresent.filter((r) => (r.composite ?? 0) >= x);
    const tp2 = p.filter((r) => r.label === "yes").length;
    const fp2 = p.filter((r) => r.label === "no").length;
    const fn2 = compositesPresent.filter(
      (r) => r.label === "yes" && (r.composite ?? 0) < x,
    ).length;
    const prec2 = p.length > 0 ? tp2 / p.length : 0;
    const yesTotal = compositesPresent.filter((r) => r.label === "yes").length;
    const rec2 = yesTotal > 0 ? tp2 / yesTotal : 0;
    console.log(
      `  ${String(x).padStart(2)}    ${String(p.length).padStart(5)}   ${String(tp2).padStart(3)}  ${String(fp2).padStart(3)}  ${String(fn2).padStart(3)}   ${(prec2 * 100).toFixed(0).padStart(4)}%   ${(rec2 * 100).toFixed(0).padStart(4)}%`,
    );
  }

  // Worst misses (narrative fodder for prompt iteration).
  const highComposite = compositesPresent
    .filter((r) => r.label === "no")
    .sort((a, b) => (b.composite ?? 0) - (a.composite ?? 0))
    .slice(0, 5);
  const lowComposite = compositesPresent
    .filter((r) => r.label === "yes")
    .sort((a, b) => (a.composite ?? 0) - (b.composite ?? 0))
    .slice(0, 5);

  if (highComposite.length > 0) {
    console.log(
      `\n[eval] scorer loved it, operator said NO (top 5 false-alarm candidates):`,
    );
    for (const r of highComposite) {
      console.log(`  c=${r.composite}  id=${r.story_id}  ${r.title.slice(0, 80)}`);
    }
  }
  if (lowComposite.length > 0) {
    console.log(
      `\n[eval] scorer dismissed it, operator said YES (top 5 miss candidates):`,
    );
    for (const r of lowComposite) {
      console.log(`  c=${r.composite}  id=${r.story_id}  ${r.title.slice(0, 80)}`);
    }
  }
}
