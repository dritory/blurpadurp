import { describe, expect, test } from "bun:test";
import { cleanTitle } from "./reddit-ootl.ts";

describe("reddit_ootl cleanTitle", () => {
  test("strips 'What's going on with' prefix", () => {
    expect(cleanTitle("What's going on with the Pelicot trial?")).toBe(
      "The Pelicot trial?",
    );
  });

  test("strips 'Whats the deal with' prefix (missing apostrophe)", () => {
    expect(cleanTitle("Whats the deal with the ChatGPT outage?")).toBe(
      "The ChatGPT outage?",
    );
  });

  test("strips 'Why is/are' prefix", () => {
    expect(cleanTitle("Why is everyone mad at OpenAI?")).toBe(
      "Everyone mad at OpenAI?",
    );
  });

  test("strips 'Can someone explain' prefix", () => {
    expect(cleanTitle("Can someone explain the Hormuz oil situation?")).toBe(
      "The Hormuz oil situation?",
    );
  });

  test("preserves titles that don't match a known prefix", () => {
    expect(cleanTitle("Middle East ceasefire negotiations")).toBe(
      "Middle East ceasefire negotiations",
    );
  });

  test("returns original on empty-after-strip", () => {
    const only = "What's going on with";
    expect(cleanTitle(only)).toBe(only);
  });
});
