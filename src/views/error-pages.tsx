import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { DEFAULT_LOCALE, type Locale, localizePath, t } from "../shared/i18n.ts";

export const NotFoundPage: FC<{ locale?: Locale }> = ({
  locale = DEFAULT_LOCALE,
}) => {
  const s = t(locale);
  return (
    <Layout title={s.errors.notFoundTitle} locale={locale}>
      <figure style="text-align: center; margin: 16px 0 28px;">
        <img
          src="/assets/blurp-404.png"
          alt={s.errors.notFoundAlt}
          style="max-width: 100%; width: 280px; height: auto; display: inline-block;"
        />
      </figure>
      <h2 style="margin-top: 0;">{s.errors.notFoundHeading}</h2>
      <p>{s.errors.notFoundBody}</p>
      <p>
        <a href={localizePath(locale, "/")}>{s.errors.latestLink}</a> ·{" "}
        <a href={localizePath(locale, "/archive")}>{s.errors.archiveLink}</a>
      </p>
    </Layout>
  );
};

export const ServerErrorPage: FC<{ detail?: string; locale?: Locale }> = ({
  detail,
  locale = DEFAULT_LOCALE,
}) => {
  const s = t(locale);
  return (
    <Layout title={s.errors.serverTitle} locale={locale}>
      <figure style="text-align: center; margin: 16px 0 28px;">
        <img
          src="/assets/blurp-500.png"
          alt={s.errors.serverAlt}
          style="max-width: 100%; width: 280px; height: auto; display: inline-block;"
        />
      </figure>
      <h2 style="margin-top: 0;">{s.errors.serverHeading}</h2>
      <p>{s.errors.serverBody}</p>
      {detail !== undefined ? (
        <pre
          style="background: #fff; border: 1px solid var(--rule); padding: 10px; font-size: 12px; overflow: auto;"
        >
          {detail}
        </pre>
      ) : null}
      <p>
        <a href={localizePath(locale, "/")}>{s.errors.latestLink}</a>
      </p>
    </Layout>
  );
};
