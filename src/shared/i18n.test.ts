import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LOCALE,
  LOCALES,
  fill,
  isLocale,
  localizePath,
  otherLocales,
  splitLocale,
  t,
} from "./i18n.ts";

describe("localizePath", () => {
  test("the default locale is unprefixed, so existing URLs never move", () => {
    expect(localizePath("en", "/")).toBe("/");
    expect(localizePath("en", "/archive")).toBe("/archive");
    expect(localizePath("en", "/issue/12")).toBe("/issue/12");
  });

  test("Norwegian pages live under /no", () => {
    expect(localizePath("nb", "/archive")).toBe("/no/archive");
    expect(localizePath("nb", "/issue/12")).toBe("/no/issue/12");
  });

  test("the Norwegian root has no trailing slash", () => {
    // "/no/" would be a second URL serving identical bytes — duplicate
    // content and a second R2 key to keep warm.
    expect(localizePath("nb", "/")).toBe("/no");
  });
});

describe("splitLocale", () => {
  test("round-trips every locale and path", () => {
    for (const locale of LOCALES) {
      for (const path of ["/", "/archive", "/issue/3", "/about"]) {
        expect(splitLocale(localizePath(locale, path))).toEqual({
          locale,
          path,
        });
      }
    }
  });

  test("an unprefixed path is the default locale", () => {
    expect(splitLocale("/archive")).toEqual({
      locale: DEFAULT_LOCALE,
      path: "/archive",
    });
  });

  test("a path that merely starts with the prefix letters is not a locale", () => {
    // /nothing must not be read as locale "n" + "othing".
    expect(splitLocale("/nothing")).toEqual({
      locale: DEFAULT_LOCALE,
      path: "/nothing",
    });
    expect(splitLocale("/nope/archive")).toEqual({
      locale: DEFAULT_LOCALE,
      path: "/nope/archive",
    });
  });
});

describe("isLocale", () => {
  test("accepts known locales and rejects everything else", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("nb")).toBe(true);
    expect(isLocale("no")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe("otherLocales", () => {
  test("excludes the current locale", () => {
    expect(otherLocales("en")).toEqual(["nb"]);
    expect(otherLocales("nb")).toEqual(["en"]);
  });
});

describe("fill", () => {
  test("substitutes named placeholders", () => {
    expect(fill("Confirmed — {email}.", { email: "a@b.c" })).toBe(
      "Confirmed — a@b.c.",
    );
  });

  test("leaves unknown placeholders alone rather than emptying them", () => {
    expect(fill("Hi {name}", {})).toBe("Hi {name}");
  });
});

describe("string tables", () => {
  // A missing translation is a type error, not a runtime one — but the
  // prose blocks are arrays, and TypeScript won't notice if a
  // translation drops a section. This catches that.
  test("every locale has the same about/privacy structure", () => {
    const en = t("en");
    for (const locale of LOCALES) {
      const s = t(locale);
      expect(s.about.blocks).toHaveLength(en.about.blocks.length);
      expect(s.privacy.blocks).toHaveLength(en.privacy.blocks.length);
      expect(s.about.blocks.map((b) => b.heading === null)).toEqual(
        en.about.blocks.map((b) => b.heading === null),
      );
    }
  });

  test("no locale ships an empty string where English has content", () => {
    // briefLanguageNote is deliberately empty on English (the brief is
    // already in English, so there is nothing to warn about).
    const en = t("en");
    for (const locale of LOCALES) {
      const s = t(locale);
      expect(s.nav.archive.length).toBeGreaterThan(0);
      expect(s.footer.silence.length).toBeGreaterThan(0);
      expect(s.subscribe.button.length).toBeGreaterThan(0);
      expect(s.about.blocks.every((b) => b.html.length > 0)).toBe(true);
      expect(s.privacy.blocks.every((b) => b.html.length > 0)).toBe(true);
    }
    expect(en.briefLanguageNote).toBe("");
  });
});
