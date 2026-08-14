import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { DEFAULT_LOCALE, type Locale, t } from "../shared/i18n.ts";

// Content mirrors docs/concept.md. Hand-authored rather than rendered from
// the markdown file at runtime to avoid a parser dep. If concept.md drifts
// from this page meaningfully, update both — concept.md is the source of
// truth for intent, this is the public version.
//
// The prose itself lives in shared/i18n.ts so the English and Norwegian
// versions sit side by side and a dropped section is visible (and
// caught by i18n.test.ts). Block HTML is hand-authored constant markup,
// never anything user-supplied.

export const About: FC<{ locale?: Locale }> = ({ locale = DEFAULT_LOCALE }) => {
  const s = t(locale);
  return (
    <Layout
      title={s.about.pageTitle}
      nav="about"
      locale={locale}
      altPath="/about"
    >
      <style
        dangerouslySetInnerHTML={{
          __html: `
          .meet-blurp { display: flex; flex-direction: column; gap: 14px; margin: 0 0 32px; }
          .meet-blurp img { display: block; width: 100%; height: auto; }
          .meet-blurp h2 { margin-top: 0; }
        `,
        }}
      />
      <section class="meet-blurp" aria-labelledby="meet-blurp">
        <img src="/assets/blurp-wide.png" alt="" />
        <div>
          <h2 id="meet-blurp">{s.about.meetHeading}</h2>
          <p>{s.about.meetBody}</p>
        </div>
      </section>

      {s.about.blocks.map((b) => (
        <>
          {b.heading !== null ? <h2>{b.heading}</h2> : null}
          <p dangerouslySetInnerHTML={{ __html: b.html }} />
        </>
      ))}

      {s.briefLanguageNote !== "" ? (
        <p>
          <em>{s.briefLanguageNote}</em>
        </p>
      ) : null}
    </Layout>
  );
};
