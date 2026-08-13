import type { Child, FC } from "hono/jsx";
import { STYLES } from "./styles.ts";
import {
  DEFAULT_LOCALE,
  HTML_LANG,
  LOCALE_NAME,
  LOCALES,
  type Locale,
  localizePath,
  otherLocales,
  t,
} from "../shared/i18n.ts";

export type NavKey = "home" | "archive" | "subscribe" | "about" | null;

export const Layout: FC<{
  title: string;
  nav?: NavKey;
  description?: string;
  canonicalPath?: string;
  locale?: Locale;
  /** App-absolute path of THIS page without a locale prefix, e.g.
   *  "/archive". Drives the hreflang alternates and the language
   *  switcher. Omitted on pages that have no counterpart in the other
   *  locale (signed-token pages, draft previews) — those get no
   *  alternates rather than links to a page that doesn't exist. */
  altPath?: string;
  children?: Child;
}> = ({
  title,
  nav = null,
  description,
  canonicalPath,
  locale = DEFAULT_LOCALE,
  altPath,
  children,
}) => {
  const s = t(locale);
  const cls = (key: NavKey) => (nav === key ? "current" : "");
  const href = (path: string) => localizePath(locale, path);
  const desc = description ?? s.siteDescription;
  return (
    <html lang={HTML_LANG[locale]}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="description" content={desc} />
        {canonicalPath !== undefined ? (
          <link rel="canonical" href={canonicalPath} />
        ) : null}
        {/* One alternate per locale plus x-default. Only emitted when
            the caller says this page exists in every locale — a
            hreflang pointing at a 404 is worse than none. */}
        {altPath !== undefined
          ? LOCALES.map((l) => (
              <link
                rel="alternate"
                hreflang={HTML_LANG[l]}
                href={localizePath(l, altPath)}
              />
            ))
          : null}
        {altPath !== undefined ? (
          <link
            rel="alternate"
            hreflang="x-default"
            href={localizePath(DEFAULT_LOCALE, altPath)}
          />
        ) : null}
        <meta property="og:site_name" content="Blurpadurp" />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={desc} />
        <meta property="og:type" content="website" />
        <meta property="og:locale" content={locale === "nb" ? "nb_NO" : "en_US"} />
        {canonicalPath !== undefined ? (
          <meta property="og:url" content={canonicalPath} />
        ) : null}
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content={title} />
        <meta name="twitter:description" content={desc} />
        {/* Explicit icon → the browser uses this instead of probing
            /favicon.ico against the origin, which the edge proxies to
            Fly (waking the machine). The SVG is edge-served from R2. */}
        <link rel="icon" type="image/svg+xml" href="/assets/blurp.svg" />
        <link rel="alternate" type="application/atom+xml" title="Blurpadurp" href="/feed.xml" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Comfortaa:wght@600;700&family=Lora:ital,wght@0,400;0,600;1,400&display=swap" />
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      </head>
      <body>
        <a href="#main" class="skip-link">{s.skipToContent}</a>
        <div class="wrap">
          <header role="banner">
            <a href={href("/")} class="brand-mark-link" aria-label={s.brandHomeLabel}>
              <img
                src="/assets/blurp.svg"
                alt=""
                class="brand-mark"
                width={104}
                height={104}
                loading="eager"
                decoding="async"
              />
            </a>
            <div class="brand-text">
              <h1 class="brand-word">
                <a href={href("/")}>Blurpadurp</a>
              </h1>
              <p class="tag">{s.tagline}</p>
              <nav aria-label={s.navLabel}>
                <a href={href("/")} class={cls("home")} aria-current={nav === "home" ? "page" : undefined}>
                  {s.nav.latest}
                </a>
                <a href={href("/archive")} class={cls("archive")} aria-current={nav === "archive" ? "page" : undefined}>
                  {s.nav.archive}
                </a>
                <a
                  href={href("/subscribe")}
                  class={cls("subscribe")}
                  aria-current={nav === "subscribe" ? "page" : undefined}
                  aria-label={s.nav.subscribe}
                >
                  {s.nav.subscribe.split("").map((ch, i) => (
                    <span
                      aria-hidden="true"
                      style={`animation-delay: ${(i * 80).toFixed(0)}ms;`}
                    >
                      {ch}
                    </span>
                  ))}
                </a>
                <a href={href("/about")} class={cls("about")} aria-current={nav === "about" ? "page" : undefined}>
                  {s.nav.about}
                </a>
              </nav>
            </div>
          </header>
          <main id="main" role="main">{children}</main>
          <footer role="contentinfo">
            <p>{s.footer.silence}</p>
            <p>
              <a href={href("/privacy")}>{s.footer.privacy}</a> ·{" "}
              <a href="/feed.xml">{s.footer.rss}</a> ·{" "}
              <a href="https://github.com/dritory/blurpadurp" rel="noopener noreferrer" target="_blank">
                {s.footer.source}
              </a>{" "}
              ·{" "}
              <a href="https://buymeacoffee.com/dritoryr" rel="noopener noreferrer" target="_blank">
                {s.footer.coffee}
              </a>
            </p>
            {altPath !== undefined ? (
              <p>
                {otherLocales(locale).map((l) => (
                  <a href={localizePath(l, altPath)} lang={HTML_LANG[l]} rel="alternate">
                    {LOCALE_NAME[l]}
                  </a>
                ))}
              </p>
            ) : null}
          </footer>
        </div>
        <script src="/assets/wave.js" defer></script>
      </body>
    </html>
  );
};

/** The note Norwegian pages carry above a brief: the site is Norwegian,
 *  the brief body is not. Renders nothing when the locale has no note,
 *  so English pages are byte-identical to before. */
export const BriefLanguageNote: FC<{ locale: Locale }> = ({ locale }) => {
  const note = t(locale).briefLanguageNote;
  if (note === "") return null;
  return (
    <p
      class="brief-lang-note"
      style="font-family: var(--sans); font-size: 13px; color: var(--ink-soft); border-left: 2px solid var(--rule); padding-left: 10px; margin: 0 0 20px;"
    >
      {note}
    </p>
  );
};
