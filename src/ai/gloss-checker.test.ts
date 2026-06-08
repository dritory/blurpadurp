import { describe, expect, test } from "bun:test";
import { renderUserMessage } from "./gloss-checker.ts";
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

describe("renderUserMessage", () => {
  test("embeds the brief and labels each candidate's regex verdict", () => {
    const msg = renderUserMessage({
      markdown: "## Brief body\n\nThe VRA was gutted.",
      candidates: CANDIDATES,
    });
    expect(msg).toContain("## Brief body");
    // The un-glossed verdict is surfaced for the model to verify.
    expect(msg).toContain("VRA [acronym] — regex thinks UN-GLOSSED");
    expect(msg).toContain("OPEC [acronym] — regex thinks GLOSSED");
    expect(msg).toContain("report_gloss_issues");
  });

  test("notes the regex blind spot when it found nothing", () => {
    const msg = renderUserMessage({ markdown: "Clean prose.", candidates: [] });
    expect(msg).toContain("can't see un-listed specialist names");
  });
});
