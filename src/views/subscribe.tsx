import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import type { Flash } from "./home.tsx";
import { DEFAULT_LOCALE, type Locale, localizePath, t } from "../shared/i18n.ts";

export const SubscribePage: FC<{ flash: Flash; locale?: Locale }> = ({
  flash,
  locale = DEFAULT_LOCALE,
}) => {
  const s = t(locale);
  return (
    <Layout
      title={s.subscribe.pageTitle}
      nav="subscribe"
      locale={locale}
      altPath="/subscribe"
    >
      <h2 style="margin-top: 0;">{s.subscribe.heading}</h2>
      <p>{s.subscribe.intro}</p>
      {s.briefLanguageNote !== "" ? (
        <p>
          <em>{s.briefLanguageNote}</em>
        </p>
      ) : null}
      {flash !== null ? (
        <div class={`flash ${flash.kind === "error" ? "error" : ""}`}>
          {flash.msg}
        </div>
      ) : null}
      {/* Posts to the locale's own /subscribe so the redirect back
          (and its flash message) stays in the reader's language. The
          handler is registered under both prefixes. */}
      <form
        class="subscribe"
        method="post"
        action={localizePath(locale, "/subscribe")}
      >
        <label for="email">{s.subscribe.emailLabel}</label>
        <div class="row">
          <input
            type="email"
            name="email"
            id="email"
            placeholder={s.subscribe.emailPlaceholder}
            required
            autocomplete="email"
          />
          <button type="submit">{s.subscribe.button}</button>
        </div>
        {/* Carries the reader's language into the subscription row, so
            the confirmation mail and every later transactional message
            arrive in the language they signed up in. */}
        <input type="hidden" name="locale" value={locale} />
        <input
          type="text"
          name="company"
          class="hp"
          tabindex={-1}
          autocomplete="off"
          aria-hidden="true"
        />
        <p class="fine">{s.subscribe.fine}</p>
      </form>
    </Layout>
  );
};
