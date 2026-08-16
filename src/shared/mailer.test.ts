import { describe, expect, test } from "bun:test";

import { formatFrom } from "./mailer.ts";

describe("formatFrom", () => {
  test("prefixes the display name so inboxes show the brand, not the local part", () => {
    expect(formatFrom("brief@blurpadurp.com", "Blurpadurp")).toBe(
      "Blurpadurp <brief@blurpadurp.com>",
    );
  });

  test("leaves an address already in mailbox form alone", () => {
    // The operator set FROM_EMAIL to a full mailbox — wrapping it again
    // would produce `Name <Other <addr>>`, which no MTA accepts.
    expect(
      formatFrom("Blurp Weekly <brief@blurpadurp.com>", "Blurpadurp"),
    ).toBe("Blurp Weekly <brief@blurpadurp.com>");
  });

  test("falls back to the bare address when there is no name", () => {
    expect(formatFrom("brief@blurpadurp.com", undefined)).toBe(
      "brief@blurpadurp.com",
    );
    expect(formatFrom("brief@blurpadurp.com", "   ")).toBe(
      "brief@blurpadurp.com",
    );
  });

  test("quotes a name containing RFC 5322 specials", () => {
    expect(formatFrom("brief@blurpadurp.com", "Blurpadurp, Weekly")).toBe(
      '"Blurpadurp, Weekly" <brief@blurpadurp.com>',
    );
    expect(formatFrom("brief@blurpadurp.com", "Blurpadurp (beta)")).toBe(
      '"Blurpadurp (beta)" <brief@blurpadurp.com>',
    );
  });

  test("escapes quotes and backslashes inside a quoted name", () => {
    expect(formatFrom("brief@blurpadurp.com", 'The "Brief"')).toBe(
      '"The \\"Brief\\"" <brief@blurpadurp.com>',
    );
  });

  test("strips CR/LF — a newline in a header value is header injection", () => {
    expect(
      formatFrom("brief@blurpadurp.com", "Blurpadurp\r\nBcc: x@y.com"),
    ).toBe('"Blurpadurp Bcc: x@y.com" <brief@blurpadurp.com>');
  });
});
