import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { DEFAULT_LOCALE, fill, type Locale, t } from "../shared/i18n.ts";

export interface Category {
  slug: string;
  name: string;
}

export interface ManageData {
  token: string;
  email: string;
  deliveryTimeLocal: string; // HH:MM:SS from Postgres; trim to HH:MM
  timezone: string;
  urgentOverride: boolean;
  categoryMutes: string[];
  categories: Category[];
  flash: { kind: "ok" | "error"; msg: string } | null;
  /** The subscriber's own language, from email_subscription.locale. The
   *  page is reached by a signed link from an email, so there is no
   *  locale in the URL to read — the row is the only source. */
  locale: Locale;
}

function hhmm(t: string): string {
  // Accept "HH:MM:SS" or "HH:MM", return "HH:MM" for the <input type=time>.
  return t.length >= 5 ? t.slice(0, 5) : t;
}

// Category names come from the DB in English. Translating them would
// mean a per-locale name column; until that exists the slug's English
// name is shown in both languages, which is at least accurate.
export const ManagePage: FC<{ data: ManageData }> = ({ data }) => {
  const muted = new Set(data.categoryMutes);
  const locale: Locale = data.locale ?? DEFAULT_LOCALE;
  const s = t(locale).manage;
  return (
    <Layout title={s.pageTitle} nav={null} locale={locale}>
      <style
        dangerouslySetInnerHTML={{
          __html: `
            .manage-form { background: #fff; border: 1px solid var(--rule); padding: 20px 22px; margin: 0 0 24px; }
            .manage-form .field { margin: 0 0 18px; }
            .manage-form label.fld { display: block; font-family: var(--sans); font-size: 13px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
            .manage-form input[type=time], .manage-form input[type=text] { padding: 8px 10px; border: 1px solid var(--rule); font-size: 15px; font-family: inherit; background: var(--paper); width: 200px; }
            .manage-form input[type=text] { width: 260px; }
            .manage-form .row-check { display: flex; align-items: flex-start; gap: 8px; }
            .manage-form .row-check label { font-family: var(--sans); font-size: 14px; color: var(--ink); }
            .manage-form .cats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 6px 14px; }
            .manage-form .cats label { font-family: var(--sans); font-size: 14px; }
            .manage-form button { padding: 10px 18px; font-size: 15px; font-family: var(--sans); background: var(--ink); color: var(--paper); border: none; cursor: pointer; }
            .manage-form .hint { font-family: var(--sans); font-size: 12px; color: var(--ink-soft); margin-top: 4px; }
            .manage-form .addr { font-family: var(--sans); font-size: 13px; color: var(--ink-soft); margin: 0 0 16px; }
            .manage-form .addr strong { color: var(--ink); }
          `,
        }}
      />
      <h2>{s.heading}</h2>
      <p
        class="addr"
        dangerouslySetInnerHTML={{
          __html: fill(s.signedInHtml, { email: escapeHtml(data.email) }),
        }}
      />
      {data.flash !== null ? (
        <div class={`flash ${data.flash.kind === "error" ? "error" : ""}`}>
          {data.flash.msg}
        </div>
      ) : null}

      <form class="manage-form" method="post" action={`/manage/${data.token}`}>
        <div class="field">
          <label class="fld" for="delivery_time_local">
            {s.deliveryTime}
          </label>
          <input
            type="time"
            id="delivery_time_local"
            name="delivery_time_local"
            value={hhmm(data.deliveryTimeLocal)}
            required
          />
          <p class="hint">{s.deliveryTimeHint}</p>
        </div>

        <div class="field">
          <label class="fld" for="timezone">
            {s.timezone}
          </label>
          <input
            type="text"
            id="timezone"
            name="timezone"
            value={data.timezone}
            placeholder="e.g. Europe/Oslo"
            required
          />
          <p
            class="hint"
            dangerouslySetInnerHTML={{ __html: s.timezoneHintHtml }}
          />
        </div>

        <div class="field row-check">
          <input
            type="checkbox"
            id="urgent_override"
            name="urgent_override"
            value="1"
            checked={data.urgentOverride}
          />
          <label for="urgent_override">{s.urgentLabel}</label>
        </div>

        <div class="field">
          <label class="fld">{s.muteHeading}</label>
          <div class="cats">
            {data.categories.map((cat) => (
              <div class="row-check">
                <input
                  type="checkbox"
                  id={`cat-${cat.slug}`}
                  name="mute"
                  value={cat.slug}
                  checked={muted.has(cat.slug)}
                />
                <label for={`cat-${cat.slug}`}>{cat.name}</label>
              </div>
            ))}
          </div>
          <p class="hint" dangerouslySetInnerHTML={{ __html: s.muteHintHtml }} />
        </div>

        <div class="field">
          <button type="submit">{s.save}</button>
        </div>
        <div class="field row-check">
          <input
            type="checkbox"
            id="unsubscribe"
            name="unsubscribe"
            value="1"
          />
          <label for="unsubscribe">{s.unsubscribeLabel}</label>
        </div>
      </form>
    </Layout>
  );
};

// The signed-in line is a translated template with the subscriber's own
// address interpolated into it, and it renders unescaped so translations
// can place the <strong>. The address is the only non-constant part, so
// it gets escaped on the way in.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
