// Deterministic gloss-linter for composed briefs.
//
// The composer prompt asks for two things the model reliably forgets on
// one or two items per issue: (1) gloss unfamiliar acronyms on FIRST use,
// and (2) gloss specialist names a literate non-specialist wouldn't know
// ("Brent", "gilt yields"). Prompt instructions alone don't catch the
// stragglers, so this is the mechanical safety net — run post-compose and
// surfaced on the /admin/review page as an advisory checklist. It does
// NOT block or rewrite; the operator eyeballs the flags and re-composes
// if needed. Pure (no DB) so it's trivially testable; the jargon term
// list is loaded from the gloss_term table by the caller and passed in.
//
// Two detectors:
//   - acronyms: a regex finds all-caps tokens (VRA, IRGC, ICC), minus
//     the whitelist below (see its comment for why it's a superset of
//     the composer prompt's list rather than a mirror of it).
//   - jargon: the caller-supplied curated list catches NON-acronym names
//     the regex can't ("Brent", "gilt", "tirzepatide") — the case the
//     user specifically flagged.
//
// "Gloss on first use" is the rule, so each distinct term is checked at
// its FIRST occurrence only; subsequent bare uses are correct and never
// flagged. The gloss heuristic is deliberately term-proximate (not
// whole-sentence) so that "Brent is at $126 and OPEC, the oil cartel, …"
// still flags bare Brent even though OPEC right beside it is glossed.
//
// FALSE ALARMS. A recall floor that cries wolf gets ignored wholesale,
// which costs more than the recall buys. Three suppressions: the
// hard-coded whitelist below, the caller's ignore list
// (gloss_term.is_ignored, mig 070), and citation link labels — an
// acronym only ever inside a markdown link label is attribution, not
// prose, and was the largest source of weekly noise.

// Bare-acronym whitelist: acronyms this linter never flags.
//
// Deliberately a SUPERSET of the composer prompt's "Bare-acronym
// whitelist" line (docs/composer-prompt.md) — the asymmetry is the safe
// direction. Over-glossing costs six words; over-flagging costs trust in
// the panel, and then the real findings go unread too. Widen here
// freely; widen the prompt only with a version bump (invariant 6).
// checker.ts renders this set into its own system prompt, so the LLM
// layer can't drift from the regex layer the way it had before.
//
// Scope: acronyms bare by RULE. Brand and newsroom names go on the
// operator's ignore list (mig 070) instead — which of those read as
// obvious shifts with the source mix and shouldn't need a deploy.
export const BARE_ACRONYM_WHITELIST: ReadonlySet<string> = new Set([
  "US",
  "USA",
  "UK",
  "EU",
  "UN",
  "NATO",
  "AI",
  "FBI",
  "CIA",
  "NASA",
  "CEO",
  "CFO",
  "GDP",
  "UAE",
  "WHO",
  "IMF",
  "USB",
  "GPS",
  "PDF",
  "URL",
  "FAQ",
  "IT",
  "PM",
  "AM",
  "GMT",
  "UTC",
  "EST",
  "CET",
]);

// A curated jargon term (a gloss_term row). `term` is matched
// case-insensitively on a whole-word boundary.
export interface JargonTerm {
  term: string;
  note: string | null;
}

export interface GlossFinding {
  // The matched term as it appears in the text (acronyms keep their
  // case; jargon reports the term from the list).
  term: string;
  kind: "acronym" | "jargon";
  // Operator note from the gloss_term row, for jargon findings.
  note: string | null;
  // The sentence containing the first occurrence, for the review panel.
  firstUseSentence: string;
  // True when a gloss construct sits next to the first use. Findings with
  // glossed=false are the ones worth the operator's attention.
  glossed: boolean;
}

// All-caps token of 2–6 chars (letters/digits, must start with a letter),
// with an optional plural/possessive suffix so "CEOs" / "VRA's" match the
// bare core. Single letters ("I", "A") are excluded by the {1,5} run.
const ACRONYM_RE = /\b([A-Z][A-Z0-9]{1,5})(?:['’]?s)?\b/g;

// Strip markdown link targets and bare URLs so the acronym detector
// doesn't trip on uppercase URL path segments. Citation domains are
// lowercase and survive harmlessly.
function stripUrls(text: string): string {
  return text
    .replace(/\]\((?:https?:\/\/)?[^)]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, "");
}

// Character ranges covered by a markdown link LABEL — the "[…]" left
// behind by stripUrls. An acronym inside one is a source credit, and
// nobody glosses a byline, so it isn't a "use": if the term also appears
// in real prose we judge it there instead, and if it never does we don't
// flag it at all.
function linkLabelSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const m of text.matchAll(/\[[^\]\n]*\]/g)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

function inSpans(spans: Array<[number, number]>, index: number): boolean {
  for (const [s, e] of spans) {
    if (index >= s && index < e) return true;
  }
  return false;
}

// Return the sentence containing [index]. Sentences break on . ! ? at a
// clause boundary, or on a newline (headlines/paragraphs). Markdown bold
// markers are stripped from the returned snippet for readability.
function sentenceAround(text: string, index: number): string {
  let start = 0;
  for (let i = index - 1; i >= 0; i--) {
    const c = text[i]!;
    if (c === "\n" || ((c === "." || c === "!" || c === "?") && /\s/.test(text[i + 1] ?? " "))) {
      start = i + 1;
      break;
    }
  }
  let end = text.length;
  for (let i = index; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\n" || ((c === "." || c === "!" || c === "?") && /\s/.test(text[i + 1] ?? " "))) {
      end = i + 1;
      break;
    }
  }
  return text.slice(start, end).replace(/\*\*/g, "").trim();
}

// Appositive / parenthetical / dash gloss attached to the term. We look
// only at the immediate neighbourhood so a gloss belonging to a different
// term in the same sentence doesn't count.
// Article/relativizer appositive, possibly at sentence end:
// "OPEC, the oil-producer cartel." / "Brent crude, which tracks…".
const TAIL_APPOSITIVE_RE =
  /^['’]?s?(?:\s+[\w$%.-]+){0,3}\s*,\s+(?:the|a|an|which|who|whose|what|or|known as|i\.e\.)\b/i;
// Comma-bracketed appositive: "IRGC, Iran's elite military force, moved."
// — a clause set off by commas on BOTH sides. The closing comma is what
// distinguishes a gloss from an ordinary trailing clause ("OPEC, met …").
const TAIL_APPOSITIVE_COMMA_RE =
  /^['’]?s?(?:\s+[\w$%.-]+){0,3}\s*,\s+[^,.!?]{3,60},/;
const TAIL_PAREN_RE = /^['’]?s?(?:\s+[\w$%.-]+){0,3}\s*\(/;
const TAIL_DASH_RE = /^['’]?s?(?:\s+[\w$%.-]+){0,3}\s*[—–]/;

function isGlossedAt(text: string, start: number, end: number): boolean {
  // Clause after the term, capped at the sentence/clause end.
  let tail = text.slice(end, end + 80);
  const tailCut = tail.search(/[.!?\n]/);
  if (tailCut >= 0) tail = tail.slice(0, tailCut + 1);
  if (
    TAIL_APPOSITIVE_RE.test(tail) ||
    TAIL_APPOSITIVE_COMMA_RE.test(tail) ||
    TAIL_PAREN_RE.test(tail) ||
    TAIL_DASH_RE.test(tail)
  ) {
    return true;
  }

  // The term is itself the parenthetical gloss of preceding words:
  // "Iran's elite military force (IRGC)". Detected by an open paren with
  // no closing paren between it and the term.
  const head = text.slice(Math.max(0, start - 80), start);
  if (/\([^)]*$/.test(head)) return true;

  return false;
}

// Lint a composed brief for un-glossed acronyms and jargon on first use.
// `text` is the composed markdown (or any prose). Findings are returned
// in first-occurrence order; both glossed and un-glossed are returned so
// the caller can show the full picture, but glossed=false is the signal.
//
// `ignoredTerms` (gloss_term.is_ignored, mig 070) are never reported at
// all — not as flagged, not as glossed. They're the operator's standing
// "yes, I know, it's fine" and the panel shouldn't spend a line on them.
export function lintGloss(
  text: string,
  jargonTerms: JargonTerm[],
  ignoredTerms: Iterable<string> = [],
): GlossFinding[] {
  const clean = stripUrls(text);
  const labels = linkLabelSpans(clean);
  const findings: GlossFinding[] = [];
  const seen = new Set<string>(); // lowercased terms already recorded
  const ignored = new Set<string>();
  for (const t of ignoredTerms) ignored.add(t.trim().toLowerCase());

  // Acronyms first, in document order. An occurrence inside a citation
  // link label is skipped rather than recorded, so a later occurrence in
  // real prose is still the one that gets judged.
  for (const m of clean.matchAll(ACRONYM_RE)) {
    const core = m[1]!;
    if (BARE_ACRONYM_WHITELIST.has(core)) continue;
    const key = core.toLowerCase();
    if (ignored.has(key) || seen.has(key)) continue;
    const start = m.index;
    if (inSpans(labels, start)) continue;
    seen.add(key);
    const end = m.index + m[0].length;
    findings.push({
      term: core,
      kind: "acronym",
      note: null,
      firstUseSentence: sentenceAround(clean, start),
      glossed: isGlossedAt(clean, start, end),
    });
  }

  // Jargon terms from the curated list. All-caps terms are skipped — the
  // acronym detector already owns those — so the list stays focused on
  // mixed/lowercase names ("Brent", "gilt") the regex can't see.
  for (const j of jargonTerms) {
    const term = j.term.trim();
    if (term.length === 0) continue;
    const key = term.toLowerCase();
    if (ignored.has(key) || seen.has(key)) continue;
    if (/^[A-Z][A-Z0-9]{1,5}$/.test(term)) continue; // pure acronym
    const re = new RegExp(
      `\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "gi",
    );
    // Same link-label rule as acronyms: a name that only ever shows up
    // as a source credit isn't a use.
    let hit: RegExpExecArray | null = null;
    for (let m = re.exec(clean); m !== null; m = re.exec(clean)) {
      if (!inSpans(labels, m.index)) {
        hit = m;
        break;
      }
    }
    if (hit === null) continue;
    seen.add(key);
    const start = hit.index;
    const end = hit.index + hit[0].length;
    findings.push({
      term,
      kind: "jargon",
      note: j.note,
      firstUseSentence: sentenceAround(clean, start),
      glossed: isGlossedAt(clean, start, end),
    });
  }

  return findings;
}
