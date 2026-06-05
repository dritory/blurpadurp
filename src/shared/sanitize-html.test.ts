import { describe, expect, test } from "bun:test";
import { sanitizeBriefHtml } from "./sanitize-html.ts";

describe("sanitizeBriefHtml", () => {
  test("preserves the composer's documented tag set", () => {
    const html =
      "<h2>Heading</h2><p>A <strong>bold</strong> <em>point</em> with a " +
      '<a href="https://example.com">link</a>.</p>' +
      "<ul><li>one</li><li>two</li></ul><blockquote>q</blockquote>";
    const out = sanitizeBriefHtml(html);
    expect(out).toContain("<h2>Heading</h2>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>point</em>");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain("<li>one</li>");
    expect(out).toContain("<blockquote>q</blockquote>");
  });

  test("strips <script> and its contents", () => {
    const out = sanitizeBriefHtml("<p>hi</p><script>alert(1)</script>");
    expect(out).toContain("<p>hi</p>");
    expect(out).not.toContain("alert(1)");
    expect(out.toLowerCase()).not.toContain("<script");
  });

  test("strips inline event handlers", () => {
    const out = sanitizeBriefHtml('<p onclick="steal()">x</p>');
    expect(out).not.toContain("onclick");
    expect(out).toContain("x");
  });

  test("drops javascript: link schemes but keeps the text", () => {
    const out = sanitizeBriefHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain("javascript:");
    expect(out).toContain("click");
  });

  test("removes img/iframe/style entirely", () => {
    const out = sanitizeBriefHtml(
      '<p>ok</p><img src="x" onerror="y"><iframe src="evil"></iframe>' +
        "<style>body{}</style>",
    );
    expect(out).toContain("<p>ok</p>");
    expect(out.toLowerCase()).not.toContain("<img");
    expect(out.toLowerCase()).not.toContain("<iframe");
    expect(out.toLowerCase()).not.toContain("<style");
  });

  test("adds rel=noopener to anchors", () => {
    const out = sanitizeBriefHtml('<a href="https://example.com">l</a>');
    expect(out).toContain('rel="noopener noreferrer"');
  });
});
