import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { DEFAULT_LOCALE, type Locale, t } from "../shared/i18n.ts";

// Plain-language privacy statement. Linked from the site footer and
// from every dispatched email's footer. Not a legal document — a
// statement of practice. If you subscribe or your address is stored,
// this page explains what happens to it.
//
// Prose lives in shared/i18n.ts alongside its translations.

export const Privacy: FC<{ locale?: Locale }> = ({
  locale = DEFAULT_LOCALE,
}) => {
  const s = t(locale);
  return (
    <Layout
      title={s.privacy.pageTitle}
      nav={null}
      locale={locale}
      altPath="/privacy"
    >
      {s.privacy.blocks.map((b) => (
        <>
          {b.heading !== null ? <h2>{b.heading}</h2> : null}
          <p dangerouslySetInnerHTML={{ __html: b.html }} />
        </>
      ))}
    </Layout>
  );
};
