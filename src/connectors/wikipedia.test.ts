import { describe, expect, test } from "bun:test";
import {
  extractCurrentEventsItems,
  firstSentence,
  stripHtml,
  wikipedia,
} from "./wikipedia.ts";
import type { RawSourceItem } from "./types.ts";

describe("stripHtml", () => {
  test("removes tags, comments, and decodes basic entities", () => {
    expect(
      stripHtml('<!-- c --><b>Tom &amp; Jerry</b> &lt;ok&gt;  spaced'),
    ).toBe("Tom & Jerry <ok> spaced");
  });
});

describe("firstSentence", () => {
  test("returns the first sentence when under max", () => {
    expect(firstSentence("A big thing happened today. More detail.", 200)).toBe(
      "A big thing happened today.",
    );
  });

  test("truncates to max when there is no early sentence boundary", () => {
    const long = "x".repeat(300);
    expect(firstSentence(long, 50)).toHaveLength(50);
  });

  test("empty string stays empty", () => {
    expect(firstSentence("", 200)).toBe("");
  });
});

describe("extractCurrentEventsItems", () => {
  test("extracts flat leaf bullets, skips navbar + thin, prefers external link", () => {
    const html = `
      <ul>
        <li class="current-events-navbar">navbar junk that is long enough</li>
        <li>Something significant happened in the region today <a class="external text" href="https://reuters.com/x">Reuters</a></li>
        <li>short</li>
      </ul>`;
    const items = extractCurrentEventsItems(html);
    expect(items).toHaveLength(1);
    expect(items[0]!.primaryUrl).toBe("https://reuters.com/x");
    expect(items[0]!.text).toContain("Something significant happened");
  });

  test("a container LI (holds a nested LI) is skipped by the heuristic", () => {
    const html = `<li>Region header<ul><li>nested leaf text long enough to count <a class="external" href="https://x.com/a">X</a></li></ul></li>`;
    // The non-greedy <li>…</li> match swallows the container up to the first
    // inner </li>; that span contains "<li" so it's skipped, and the nested
    // leaf isn't re-matched. Documents the regex parser's known limitation.
    expect(extractCurrentEventsItems(html)).toHaveLength(0);
  });

  test("falls back to a /wiki/ link and absolutizes it", () => {
    const html = `<li>A notable enough event occurred this week somewhere
      <a href="/wiki/Some_Event">Some Event</a></li>`;
    const items = extractCurrentEventsItems(html);
    expect(items[0]!.primaryUrl).toBe("https://en.wikipedia.org/wiki/Some_Event");
  });
});

describe("wikipedia.normalize", () => {
  test("in_the_news: title is the story sentence, not the article name", () => {
    const item: RawSourceItem = {
      source_event_id: "u",
      fetched_at: new Date(),
      raw: {
        scope: "in_the_news",
        primaryTitle: "Nord (yacht)",
        primaryUrl: "https://en.wikipedia.org/wiki/Nord_(yacht)",
        storyHtml: "<b>x</b>",
        storyText: "A Russian oligarch's superyacht crossed the strait today.",
        fetchedAt: new Date(),
      },
    };
    const n = wikipedia.normalize(item);
    expect(n.source_name).toBe("wikipedia");
    expect(n.title).toContain("superyacht crossed the strait");
    expect(n.title).not.toBe("Nord (yacht)");
    expect(n.published_at).toBeNull();
  });

  test("current_events: published_at parsed from the day", () => {
    const item: RawSourceItem = {
      source_event_id: "hash",
      fetched_at: new Date(),
      raw: {
        scope: "current_events",
        date: "2026-06-01",
        text: "Something consequential was reported across multiple outlets.",
        primaryUrl: "https://reuters.com/x",
        primaryTitle: "Reuters",
        fetchedAt: new Date(),
      },
    };
    const n = wikipedia.normalize(item);
    expect(n.source_url).toBe("https://reuters.com/x");
    expect(n.published_at?.toISOString().slice(0, 10)).toBe("2026-06-01");
  });
});
