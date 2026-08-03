import { describe, expect, test } from "bun:test";
import { lintGloss, type JargonTerm } from "./gloss-lint.ts";

const JARGON: JargonTerm[] = [
  { term: "Brent", note: "oil benchmark" },
  { term: "gilt", note: "UK government bond" },
  { term: "tirzepatide", note: "weight-loss drug" },
];

function flagged(
  text: string,
  jargon: JargonTerm[] = JARGON,
  ignored: string[] = [],
): string[] {
  return lintGloss(text, jargon, ignored)
    .filter((f) => !f.glossed)
    .map((f) => f.term);
}

describe("acronym detection", () => {
  test("flags a bare un-glossed acronym", () => {
    expect(flagged("Section 2 of the VRA was gutted this week.")).toContain(
      "VRA",
    );
  });

  test("does not flag whitelisted acronyms", () => {
    const f = flagged("The US, the UK, the EU, NATO and the FBI all agreed.");
    expect(f).toEqual([]);
  });

  test("treats a comma appositive as a gloss", () => {
    const out = lintGloss("OPEC, the oil-producer cartel, met Tuesday.", []);
    const opec = out.find((f) => f.term === "OPEC");
    expect(opec?.glossed).toBe(true);
  });

  test("treats an inline parenthetical as a gloss", () => {
    const out = lintGloss("The court accepted an EMA (medicines regulator) finding.", []);
    expect(out.find((f) => f.term === "EMA")?.glossed).toBe(true);
  });

  test("treats the acronym-as-parenthetical-target as a gloss", () => {
    const out = lintGloss("Iran's elite military force (IRGC) mobilised.", []);
    expect(out.find((f) => f.term === "IRGC")?.glossed).toBe(true);
  });

  test("only flags the FIRST use, ignoring later bare uses", () => {
    const out = lintGloss(
      "The IRGC, Iran's elite military force, moved. The IRGC then withdrew.",
      [],
    );
    const irgc = out.filter((f) => f.term === "IRGC");
    expect(irgc.length).toBe(1);
    expect(irgc[0]?.glossed).toBe(true);
  });

  test("plural and possessive acronyms collapse to the bare core", () => {
    const out = lintGloss("Several CEOs spoke; one CEO's remarks stood out.", []);
    // CEO is whitelisted, so no finding at all.
    expect(out.find((f) => f.term === "CEO")).toBeUndefined();
  });
});

describe("jargon detection", () => {
  test("flags a bare jargon name the acronym regex can't see", () => {
    expect(flagged("Brent is at $126 a barrel.")).toContain("Brent");
  });

  test("a comma appositive glosses a jargon name", () => {
    expect(flagged("Brent crude, the oil benchmark, is at $126.")).not.toContain(
      "Brent",
    );
  });

  test("a dash gloss counts for jargon", () => {
    expect(
      flagged("Gilt yields — what the UK government pays to borrow — hit a high.", [
        { term: "gilt", note: null },
      ]),
    ).not.toContain("gilt");
  });

  test("jargon is matched case-insensitively", () => {
    expect(flagged("A new tirzepatide rival appeared.")).toContain("tirzepatide");
  });
});

describe("the Brent-beside-OPEC case", () => {
  // The motivating bug: a gloss for one term must not mask a bare term
  // sitting right next to it in the same sentence.
  test("flags bare Brent even though OPEC beside it is glossed", () => {
    const text =
      "Brent is at $126 and OPEC, the oil-producer cartel, has lost the UAE.";
    const f = flagged(text);
    expect(f).toContain("Brent");
    expect(f).not.toContain("OPEC");
  });
});

describe("URL handling", () => {
  test("ignores uppercase inside link targets / urls", () => {
    const text =
      "The deal closed. ( [reuters.com](https://reuters.com/WORLD/ABC) )";
    // No prose acronyms; the URL path must not produce a finding.
    expect(lintGloss(text, []).map((f) => f.term)).toEqual([]);
  });
});

describe("citation link labels", () => {
  // The single biggest source of weekly false alarms: every issue cites
  // its sources as markdown links, and an acronym in a link LABEL is a
  // source credit, not prose. Nobody glosses a byline.
  test("an acronym only ever used as a source credit is not flagged", () => {
    const text = "The tribunal ruled on Tuesday. ([BBC](https://bbc.co.uk/x))";
    expect(lintGloss(text, []).map((f) => f.term)).toEqual([]);
  });

  test("but the same acronym used in prose still is", () => {
    const text =
      "The VRA was gutted this week. ([VRA explainer](https://ex.com/a))";
    expect(flagged(text)).toContain("VRA");
  });

  test("a label occurrence doesn't consume the term's first use", () => {
    // The link comes FIRST. If the label counted as the first use, the
    // bare prose use after it would be treated as a correct later use
    // and never flagged — a silent miss, the expensive direction.
    const text =
      "([IRGC report](https://ex.com/a)) The IRGC mobilised overnight.";
    expect(flagged(text)).toContain("IRGC");
  });
});

describe("ignore list", () => {
  test("an ignored acronym is not reported at all", () => {
    const out = lintGloss("IBM said the outage lasted an hour.", [], ["IBM"]);
    expect(out).toEqual([]);
  });

  test("ignoring is case-insensitive", () => {
    expect(lintGloss("BBC said so.", [], ["bbc"])).toEqual([]);
  });

  test("an ignored jargon term is not reported either", () => {
    expect(lintGloss("Brent is at $126.", JARGON, ["brent"])).toEqual([]);
  });

  test("ignoring one term doesn't suppress its neighbours", () => {
    const f = flagged("IBM sued, and the VRA case resumed.", JARGON, ["IBM"]);
    expect(f).not.toContain("IBM");
    expect(f).toContain("VRA");
  });
});
