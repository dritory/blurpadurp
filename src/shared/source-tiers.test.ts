import { describe, expect, test } from "bun:test";
import { countTier1, domainOf, isTier1 } from "./source-tiers.ts";

describe("domainOf", () => {
  test("strips www and lowercases", () => {
    expect(domainOf("https://WWW.Reuters.com/world")).toBe("reuters.com");
  });

  test("returns null on an unparseable url", () => {
    expect(domainOf("not a url")).toBeNull();
  });
});

describe("isTier1", () => {
  test("true for a known tier-1 outlet (incl. www + path)", () => {
    expect(isTier1("https://www.nytimes.com/2026/01/01/x.html")).toBe(true);
    expect(isTier1("https://apnews.com/article/abc")).toBe(true);
  });

  test("false for an unknown outlet and for junk", () => {
    expect(isTier1("https://someblog.example.com/post")).toBe(false);
    expect(isTier1("garbage")).toBe(false);
  });
});

describe("countTier1", () => {
  test("counts only tier-1 urls", () => {
    expect(
      countTier1([
        "https://reuters.com/a",
        "https://random.example/b",
        "https://bbc.co.uk/c",
      ]),
    ).toBe(2);
  });

  test("zero for an empty iterable", () => {
    expect(countTier1([])).toBe(0);
  });
});
