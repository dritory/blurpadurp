import { describe, expect, test } from "bun:test";
import { renderUserMessage } from "./composer.ts";
import type {
  ComposerInput,
  ComposerItem,
} from "../shared/composer-schema.ts";

// Catch-up stories (composer v0.10) are older than the week the brief
// covers. Every framing rule in composer-prompt.md otherwise assumes the
// last seven days — down to a gold example that writes "warned this
// week" — so without the flag reaching the model a three-week-old story
// is narrated as fresh news. That isn't a tone slip; the brief states
// something false.
//
// Two properties matter here:
//   1. the flag reaches the model for catch-up stories, and
//   2. it is ABSENT for normal ones — the composer caches on a hash of
//      (system, userMessage), so an unconditional line would change the
//      hash of every ordinary run and throw away the cache.

function story(
  id: number,
  over: Partial<ComposerItem["stories"][number]> = {},
): ComposerItem["stories"][number] {
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
    ...over,
  };
}

function input(stories: ComposerItem["stories"]): ComposerInput {
  return {
    week_of: "2026-08-01",
    conversation: [
      {
        kind: stories.length > 1 ? "arc" : "single",
        rank: 1,
        lead_story_id: stories[0]!.story_id,
        reason: "because",
        stories,
      },
    ],
    worth_knowing: [],
    worth_watching: [],
    shrug: [],
    synthesis_themes: [],
    theme_timelines: [],
    recent_issues: [],
  };
}

describe("renderUserMessage — catch-up flag", () => {
  test("a catch-up story is marked, with its age", () => {
    const msg = renderUserMessage(
      input([story(1, { catch_up: true, age_days: 19 })]),
    );
    expect(msg).toContain("catch_up: true");
    expect(msg).toContain("age_days: 19");
    // The instruction travels with the datum — the model shouldn't have
    // to remember the prompt rule to know what the flag means.
    expect(msg).toContain('never "this week"');
  });

  // Cache safety: an ordinary run must render exactly as it did in v0.9.
  test("a normal story renders no catch-up line at all", () => {
    const msg = renderUserMessage(input([story(1)]));
    expect(msg).not.toContain("catch_up");
    expect(msg).not.toContain("age_days");
  });

  test("a normal story's message is unchanged by the feature existing", () => {
    // Same input rendered twice must be byte-identical, and must not
    // mention the new fields anywhere.
    const a = renderUserMessage(input([story(1), story(2)]));
    const b = renderUserMessage(input([story(1), story(2)]));
    expect(a).toBe(b);
    expect(a.includes("catch_up")).toBe(false);
  });

  // Mixed arc: the old member is flagged, the fresh one isn't, so the
  // composer dates only what needs dating.
  test("a mixed arc flags only the catch-up member", () => {
    const msg = renderUserMessage(
      input([story(1, { catch_up: true, age_days: 17 }), story(2)]),
    );
    expect(msg.match(/catch_up: true/g)).toHaveLength(1);
    expect(msg).toContain("age_days: 17");
  });
});
