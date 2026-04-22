import type { Child, FC } from "hono/jsx";
import { STYLES } from "./styles.ts";

export type NavKey = "home" | "archive" | "about" | null;

const DEFAULT_DESC =
  "The anti-social-media zeitgeist brief. Subscribe once, quit social media.";

export const Layout: FC<{
  title: string;
  nav?: NavKey;
  description?: string;
  canonicalPath?: string;
  children?: Child;
}> = ({
  title,
  nav = null,
  description = DEFAULT_DESC,
  canonicalPath,
  children,
}) => {
  const cls = (key: NavKey) => (nav === key ? "current" : "");
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="description" content={description} />
        {canonicalPath !== undefined ? (
          <link rel="canonical" href={canonicalPath} />
        ) : null}
        <meta property="og:site_name" content="Blurpadurp" />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:type" content="website" />
        {canonicalPath !== undefined ? (
          <meta property="og:url" content={canonicalPath} />
        ) : null}
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content={title} />
        <meta name="twitter:description" content={description} />
        <link rel="alternate" type="application/atom+xml" title="Blurpadurp" href="/feed.xml" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,600;1,400&display=swap" />
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      </head>
      <body>
        <a href="#main" class="skip-link">Skip to content</a>
        <div class="wrap">
          <header role="banner">
            <h1>
              <a href="/">Blurpadurp</a>
            </h1>
            <p class="tag">The anti-social-media zeitgeist brief.</p>
            <nav aria-label="Primary">
              <a href="/" class={cls("home")} aria-current={nav === "home" ? "page" : undefined}>
                Latest
              </a>
              <a href="/archive" class={cls("archive")} aria-current={nav === "archive" ? "page" : undefined}>
                Archive
              </a>
              <a href="/about" class={cls("about")} aria-current={nav === "about" ? "page" : undefined}>
                About
              </a>
            </nav>
          </header>
          <main id="main" role="main">{children}</main>
          <footer role="contentinfo">
            <p>Silence is a feature. If nothing clears the bar, nothing publishes.</p>
          </footer>
        </div>
      </body>
    </html>
  );
};
