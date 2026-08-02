import { describe, expect, test } from "bun:test";
import { buildPickRows } from "./compose.ts";
import type {
  ComposerInput,
  ComposerItem,
  ShrugItem,
} from "../shared/composer-schema.ts";

function story(id: number): ComposerItem["stories"][number] {
  return {
    story_id: id,
    title: `story ${id}`,
    summary: null,
    source_url: null,
    additional_source_urls: [],
    category: null,
    theme_name: null,
    theme_relationship: null,
    zeitgeist_score: 0,
    half_life: 0,
    reach: 0,
    composite: 0,
    scorer_one_liner: "",
    retrodiction_12mo: "",
    published_at: null,
    catch_up: false,
    age_days: 0,
  };
}

function item(rank: number, ids: number[]): ComposerItem {
  return {
    kind: ids.length > 1 ? "arc" : "single",
    rank,
    lead_story_id: ids[0]!,
    stories: ids.map(story),
    reason: "",
  };
}

function shrug(id: number): ShrugItem {
  return {
    story_id: id,
    title: `shrug ${id}`,
    source_url: null,
    category: null,
    penalty_factors: [],
    source_count: 1,
    scorer_one_liner: "",
  };
}

function input(partial: Partial<ComposerInput>): ComposerInput {
  return {
    week_of: "2026-06-05",
    conversation: [],
    worth_knowing: [],
    worth_watching: [],
    shrug: [],
    synthesis_themes: [],
    theme_timelines: [],
    ...partial,
  };
}

describe("buildPickRows", () => {
  test("tags each story with its section and the item's rank", () => {
    const rows = buildPickRows(
      7,
      input({
        conversation: [item(1, [10])],
        worth_knowing: [item(6, [20])],
        worth_watching: [item(11, [30])],
      }),
    );
    expect(rows).toEqual([
      { issue_id: 7, story_id: 10, section: "conversation", rank: 1 },
      { issue_id: 7, story_id: 20, section: "worth_knowing", rank: 6 },
      { issue_id: 7, story_id: 30, section: "worth_watching", rank: 11 },
    ]);
  });

  test("an arc expands to one row per constituent, sharing section + rank", () => {
    const rows = buildPickRows(1, input({ conversation: [item(2, [10, 11, 12])] }));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.section === "conversation" && r.rank === 2)).toBe(
      true,
    );
    expect(rows.map((r) => r.story_id)).toEqual([10, 11, 12]);
  });

  test("includes shrug ids (1-based rank) — prevents cross-issue recurrence", () => {
    const rows = buildPickRows(1, input({ shrug: [shrug(40), shrug(41)] }));
    expect(rows).toEqual([
      { issue_id: 1, story_id: 40, section: "shrug", rank: 1 },
      { issue_id: 1, story_id: 41, section: "shrug", rank: 2 },
    ]);
  });

  test("dedupes a story that appears in multiple sections (first wins)", () => {
    const rows = buildPickRows(
      1,
      input({
        conversation: [item(1, [10])],
        worth_watching: [item(11, [10])], // same id, later section
        shrug: [shrug(10)],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      issue_id: 1,
      story_id: 10,
      section: "conversation",
      rank: 1,
    });
  });
});
