import { describe, expect, test } from "bun:test";
import {
  SHRUG_PENALTY_FACTORS,
  humanizePenaltyFactor,
  selectShrugCandidates,
} from "./compose-shrug.ts";

// Locks the v0.12 fix: the shrug section's five slots are spread across
// penalty factors instead of going to the five most-syndicated stories.
// Ranking by source_count alone was very nearly a controversy_flash
// sort, and a composer handed five identically-tagged rows wrote five
// identically-shaped sentences.

const cand = (story_id: number, factors: string[], source_count: number) => ({
  story_id,
  penalty_factors: factors,
  source_count,
});

const labels = (sel: { label_factor: string }[]) =>
  sel.map((s) => s.label_factor);
const ids = (sel: { candidate: { story_id: number } }[]) =>
  sel.map((s) => s.candidate.story_id);

describe("selectShrugCandidates", () => {
  test("spreads labels across factors rather than taking the loudest five", () => {
    // The failing shape: controversy_flash carries the syndication, so a
    // pure source_count sort hands it every slot.
    const pool = [
      cand(1, ["controversy_flash"], 9),
      cand(2, ["controversy_flash"], 8),
      cand(3, ["controversy_flash"], 7),
      cand(4, ["controversy_flash"], 6),
      cand(5, ["in_circle_hype"], 3),
      cand(6, ["manufactured_hype"], 2),
    ];
    const picked = selectShrugCandidates(pool, 5);

    expect(picked).toHaveLength(5);
    expect(new Set(labels(picked)).size).toBe(3);
    // The quiet factors make the cut despite losing the source race.
    expect(ids(picked)).toContain(5);
    expect(ids(picked)).toContain(6);
  });

  test("cycles the rota when the limit exceeds the factor count", () => {
    const pool = [
      cand(1, ["controversy_flash"], 9),
      cand(2, ["controversy_flash"], 8),
      cand(3, ["in_circle_hype"], 5),
      cand(4, ["in_circle_hype"], 4),
      cand(5, ["manufactured_hype"], 3),
    ];
    const picked = selectShrugCandidates(pool, 5);

    // Cycle one takes one of each; cycle two takes the seconds.
    expect(labels(picked).slice(0, 3).sort()).toEqual([
      "controversy_flash",
      "in_circle_hype",
      "manufactured_hype",
    ]);
    expect(picked).toHaveLength(5);
  });

  test("source_count still ranks within a factor", () => {
    const pool = [
      cand(1, ["in_circle_hype"], 2),
      cand(2, ["in_circle_hype"], 7),
      cand(3, ["controversy_flash"], 4),
    ];
    const picked = selectShrugCandidates(pool, 2);
    expect(ids(picked)).toEqual([2, 3]);
  });

  test("a genuinely monotonous week stays monotonous (no invention)", () => {
    const pool = [
      cand(1, ["controversy_flash"], 5),
      cand(2, ["controversy_flash"], 4),
      cand(3, ["controversy_flash"], 3),
    ];
    const picked = selectShrugCandidates(pool, 5);
    expect(ids(picked)).toEqual([1, 2, 3]);
    expect(labels(picked)).toEqual([
      "controversy_flash",
      "controversy_flash",
      "controversy_flash",
    ]);
  });

  test("a multi-factor row is labelled with whatever the rota still needs", () => {
    const pool = [
      cand(1, ["controversy_flash"], 9),
      cand(2, ["controversy_flash", "in_circle_hype"], 8),
    ];
    const picked = selectShrugCandidates(pool, 2);
    expect(labels(picked)).toEqual(["controversy_flash", "in_circle_hype"]);
  });

  test("deterministic on source_count ties — composer cache is hash-keyed", () => {
    const pool = [
      cand(7, ["controversy_flash"], 4),
      cand(3, ["controversy_flash"], 4),
      cand(5, ["controversy_flash"], 4),
    ];
    expect(ids(selectShrugCandidates(pool, 3))).toEqual([3, 5, 7]);
    expect(ids(selectShrugCandidates([...pool].reverse(), 3))).toEqual([
      3, 5, 7,
    ]);
  });

  test("terminates and stays in-bounds on odd input", () => {
    expect(selectShrugCandidates([], 5)).toEqual([]);
    expect(selectShrugCandidates([cand(1, [], 1)], 5)).toHaveLength(1);
    expect(selectShrugCandidates([cand(1, ["weird_factor"], 1)], 5)).toEqual([
      { candidate: cand(1, ["weird_factor"], 1), label_factor: "weird_factor" },
    ]);
  });
});

describe("humanizePenaltyFactor", () => {
  test("maps every qualifying factor to a reader-facing tag", () => {
    expect(SHRUG_PENALTY_FACTORS.map(humanizePenaltyFactor)).toEqual([
      "in-circle hype",
      "manufactured hype",
      "48-hour controversy",
    ]);
  });

  test("degrades unmapped factors instead of leaking underscores", () => {
    expect(humanizePenaltyFactor("some_new_factor")).toBe("some new factor");
  });
});
