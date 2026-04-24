import type { Child, FC } from "hono/jsx";
import { STYLES } from "./styles.ts";

export type NavKey = "home" | "archive" | "subscribe" | "about" | null;

const DEFAULT_DESC =
  "Reads the internet so you don't have to. One brief a week, or nothing.";

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
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Comfortaa:wght@600;700&family=Lora:ital,wght@0,400;0,600;1,400&display=swap" />
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      </head>
      <body>
        <a href="#main" class="skip-link">Skip to content</a>
        <div class="wrap">
          <header role="banner">
            <a href="/" class="brand-mark-link" aria-label="Blurpadurp — home">
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
                <a href="/">Blurpadurp</a>
              </h1>
              <p class="tag">Reads the internet so you don't have to.</p>
              <nav aria-label="Primary">
                <a href="/" class={cls("home")} aria-current={nav === "home" ? "page" : undefined}>
                  Latest
                </a>
                <a href="/archive" class={cls("archive")} aria-current={nav === "archive" ? "page" : undefined}>
                  Archive
                </a>
                <a
                  href="/subscribe"
                  class={cls("subscribe")}
                  aria-current={nav === "subscribe" ? "page" : undefined}
                  aria-label="Subscribe"
                >
                  {"Subscribe".split("").map((ch, i) => (
                    <span
                      aria-hidden="true"
                      style={`animation-delay: ${(i * 80).toFixed(0)}ms;`}
                    >
                      {ch}
                    </span>
                  ))}
                </a>
                <a href="/about" class={cls("about")} aria-current={nav === "about" ? "page" : undefined}>
                  About
                </a>
              </nav>
            </div>
          </header>
          <main id="main" role="main">{children}</main>
          <footer role="contentinfo">
            <p>Silence is a feature. If nothing clears the bar, nothing publishes.</p>
            <p>
              <a href="/privacy">Privacy</a> · <a href="/feed.xml">RSS</a>
            </p>
          </footer>
        </div>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var k="blurp_last_wave",n=Date.now(),l=Number(sessionStorage.getItem(k)||0);if(n-l>=10000){var a=document.querySelector('a[href="/subscribe"]');if(a){a.classList.add("waving");sessionStorage.setItem(k,String(n));setTimeout(function(){a.classList.remove("waving");},1800);}}}catch(e){}})();`,
          }}
        />
      </body>
    </html>
  );
};
