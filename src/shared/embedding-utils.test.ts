import { describe, expect, test } from "bun:test";
import {
  averageVectors,
  embeddingTextForStory,
  parsePgVector,
} from "./embedding-utils.ts";

describe("parsePgVector", () => {
  test("parses a pgvector literal into numbers", () => {
    expect(parsePgVector("[1,2,3.5]")).toEqual([1, 2, 3.5]);
  });

  test("null/empty inputs return null", () => {
    expect(parsePgVector(null)).toBeNull();
    expect(parsePgVector("[]")).toBeNull();
    expect(parsePgVector("")).toBeNull();
  });
});

describe("averageVectors", () => {
  test("element-wise mean", () => {
    expect(averageVectors([[1, 2], [3, 4]])).toEqual([2, 3]);
  });

  test("empty input yields empty vector", () => {
    expect(averageVectors([])).toEqual([]);
  });
});

describe("embeddingTextForStory", () => {
  test("prefers the denormalized scorer_summary", () => {
    const text = embeddingTextForStory({
      title: "Title",
      summary: "raw summary",
      scorer_summary: "scorer line",
    });
    expect(text).toBe("Title\n\nscorer line");
  });

  test("falls back to raw_output.summary, then one_line_summary", () => {
    expect(
      embeddingTextForStory({
        title: "T",
        summary: null,
        raw_output: { summary: "from raw" },
      }),
    ).toBe("T\n\nfrom raw");
    expect(
      embeddingTextForStory({
        title: "T",
        summary: null,
        raw_output: { one_line_summary: "v0.1 line" },
      }),
    ).toBe("T\n\nv0.1 line");
  });

  test("falls back to raw summary, then to title alone", () => {
    expect(
      embeddingTextForStory({ title: "T", summary: "raw" }),
    ).toBe("T\n\nraw");
    expect(embeddingTextForStory({ title: "T", summary: null })).toBe("T");
  });
});
