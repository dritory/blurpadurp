import type { FC } from "hono/jsx";
import { STYLES } from "./styles.ts";

export type NavKey = "home" | "archive" | "about" | null;

export const Layout: FC<{ title: string; nav?: NavKey }> = ({
  title,
  nav = null,
  children,
}) => {
  const cls = (key: NavKey) => (nav === key ? "current" : "");
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="description" content="The anti-social-media zeitgeist brief. Subscribe once, quit social media." />
        <link rel="alternate" type="application/atom+xml" title="Blurpadurp" href="/feed.xml" />
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      </head>
      <body>
        <div class="wrap">
          <header>
            <h1>
              <a href="/">Blurpadurp</a>
            </h1>
            <p class="tag">The anti-social-media zeitgeist brief.</p>
            <nav>
              <a href="/" class={cls("home")}>Latest</a>
              <a href="/archive" class={cls("archive")}>Archive</a>
              <a href="/about" class={cls("about")}>About</a>
            </nav>
          </header>
          {children}
          <footer>
            <p>Silence is a feature. If nothing clears the bar, nothing publishes.</p>
          </footer>
        </div>
      </body>
    </html>
  );
};
