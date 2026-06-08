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
});
