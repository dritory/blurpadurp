import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { DEFAULT_LOCALE, type Locale, localizePath, t } from "../shared/i18n.ts";

// Signed-link outcome page (confirm / unsubscribe / bad token). No
// altPath: these URLs carry a one-shot token and have no counterpart in
// another locale, so they get no hreflang and no language switcher.
export const TokenResultPage: FC<{
  title: string;
  body: string;
  error?: boolean;
  locale?: Locale;
}> = ({ title, body, error = false, locale = DEFAULT_LOCALE }) => (
  <Layout title={`${title} — Blurpadurp`} locale={locale}>
    <div class={`flash ${error ? "error" : ""}`}>{body}</div>
    <p>
      <a href={localizePath(locale, "/")}>{t(locale).token.backToLatest}</a>
    </p>
  </Layout>
);
