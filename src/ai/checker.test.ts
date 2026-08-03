import { describe, expect, test } from "bun:test";
import { renderGlossUserMessage } from "./checker.ts";
import type { GlossFinding } from "../shared/gloss-lint.ts";

const CANDIDATES: GlossFinding[] = [
  {
    term: "VRA",
    kind: "acronym",
    note: null,
    firstUseSentence: "The VRA was gutted.",
    glossed: false,
  },
  {
    term: "OPEC",
    kind: "acronym",
    note: null,
    firstUseSentence: "OPEC, the oil cartel, met.",
    glossed: true,
  },
];

describe("renderGlossUserMessage", () => {
  test("embeds the brief and labels each candidate's regex verdict", () => {
    const msg = renderGlossUserMessage({
      markdown: "## Brief body\n\nThe VRA was gutted.",
      glossCandidates: CANDIDATES,
    });
    expect(msg).toContain("## Brief body");
    expect(msg).toContain("VRA [acronym] — regex thinks UN-GLOSSED");
    expect(msg).toContain("OPEC [acronym] — regex thinks GLOSSED");
    expect(msg).toContain("report_gloss_issues");
  });

  test("notes the regex blind spot when it found nothing", () => {
    const msg = renderGlossUserMessage({
      markdown: "Clean prose.",
      glossCandidates: [],
    });
    expect(msg).toContain("can't see un-listed specialist names");
  });

  test("passes the operator ignore list through as a hard rule", () => {
    // The linter already drops these; repeating them to the model is
    // what stops it re-introducing a term the operator waved through,
    // which is how the two layers ended up contradicting each other.
    const msg = renderGlossUserMessage({
      markdown: "IBM said so.",
      glossCandidates: [],
      ignoredTerms: ["IBM", "BBC"],
    });
    expect(msg).toContain("Operator ignore list");
    expect(msg).toContain("IBM, BBC");
  });

  test("omits the ignore section when there is nothing ignored", () => {
    const msg = renderGlossUserMessage({
      markdown: "Clean prose.",
      glossCandidates: [],
      ignoredTerms: [],
    });
    expect(msg).not.toContain("Operator ignore list");
  });
});

describe("the two layers agree on what goes bare", () => {
  test("the checker prompt renders the linter's whitelist verbatim", async () => {
    // They were maintained as two hand-typed lists and had already
    // drifted — the regex flagged terms the prompt told the model to
    // ignore, on the same page. Rendering one from the other makes that
    // impossible; this test guards the wiring.
    const { BARE_ACRONYM_WHITELIST } = await import("../shared/gloss-lint.ts");
    const src = await Bun.file("src/ai/checker.ts").text();
    const line = src.match(/const WHITELIST_LINE = (.+);/)?.[1] ?? "";
    expect(line).toContain("BARE_ACRONYM_WHITELIST");
    expect(BARE_ACRONYM_WHITELIST.has("NATO")).toBe(true);
    // Brand names are the operator's call (mig 070 ignore list), not a
    // hard-coded rule — see the comment on the whitelist.
    expect(BARE_ACRONYM_WHITELIST.has("BBC")).toBe(false);
  });
});
