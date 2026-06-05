// Server-side allowlist sanitizer for the composed brief HTML.
//
// The composer LLM emits an `html` field (src/ai/composer.ts) that is
// stored verbatim as issue.composed_html and rendered via
// dangerouslySetInnerHTML on public + admin pages. That HTML is derived
// from attacker-influenceable inputs (RSS/GDELT/Reddit titles flow into
// the prompt; CLAUDE.md names "hostile RSS title" as a real threat), so
// it must be sanitized before it reaches the DOM. The CSP in
// security-headers.ts blocks inline scripts as a backstop, but defence
// must not rest on a single header — strip anything outside the
// composer's documented tag set here.
//
// Run at the render boundary (so already-stored issues are covered too),
// before admin anchor decoration (decorateBriefHtml), which re-adds our
// own safe data-* attributes afterwards.

import sanitizeHtml from "sanitize-html";

// The composer is instructed to emit headers, paragraphs, lists,
// emphasis, blockquotes, code, and links. Everything else is dropped.
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "br", "hr",
    "a", "strong", "b", "em", "i", "u", "s",
    "ul", "ol", "li",
    "blockquote", "code", "pre", "span",
  ],
  allowedAttributes: {
    a: ["href", "title", "rel"],
    // class is presentational only and cannot execute; allow it so the
    // composer's occasional styling hooks survive without widening the
    // attack surface.
    "*": ["class"],
  },
  // No javascript:/data: link schemes. mailto kept for the rare citation.
  allowedSchemes: ["http", "https", "mailto"],
  // Force external links to drop the opener reference; harmless on
  // same-page anchors.
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }, true),
  },
  // Drop the contents of anything we strip (e.g. <script>…</script>),
  // rather than leaking the inner text.
  nonTextTags: ["style", "script", "textarea", "option", "noscript"],
};

export function sanitizeBriefHtml(html: string): string {
  return sanitizeHtml(html, OPTIONS);
}
