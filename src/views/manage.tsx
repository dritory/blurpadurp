import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";

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
}

function hhmm(t: string): string {
  // Accept "HH:MM:SS" or "HH:MM", return "HH:MM" for the <input type=time>.
  return t.length >= 5 ? t.slice(0, 5) : t;
}

export const ManagePage: FC<{ data: ManageData }> = ({ data }) => {
  const muted = new Set(data.categoryMutes);
  return (
    <Layout title="Preferences — Blurpadurp" nav={null}>
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
      <h2>Preferences</h2>
      <p class="addr">
        Signed in as <strong>{data.email}</strong> via a one-shot link. No
        password, no login — the link is your authorization.
      </p>
      {data.flash !== null ? (
        <div class={`flash ${data.flash.kind === "error" ? "error" : ""}`}>
          {data.flash.msg}
        </div>
      ) : null}

      <form class="manage-form" method="post" action={`/manage/${data.token}`}>
        <div class="field">
          <label class="fld" for="delivery_time_local">
            Delivery time
          </label>
          <input
            type="time"
            id="delivery_time_local"
            name="delivery_time_local"
            value={hhmm(data.deliveryTimeLocal)}
            required
          />
          <p class="hint">Local time to dispatch. Issues arrive within ±30 min.</p>
        </div>

        <div class="field">
          <label class="fld" for="timezone">
            Timezone
          </label>
          <input
            type="text"
            id="timezone"
            name="timezone"
            value={data.timezone}
            placeholder="e.g. Europe/Oslo"
            required
          />
          <p class="hint">
            IANA timezone name (America/New_York, Asia/Tokyo, UTC …). List:
            {" "}
            <a
              href="https://en.wikipedia.org/wiki/List_of_tz_database_time_zones"
              rel="noopener noreferrer"
              target="_blank"
            >
              tz database
            </a>.
          </p>
        </div>

        <div class="field row-check">
          <input
            type="checkbox"
            id="urgent_override"
            name="urgent_override"
            value="1"
            checked={data.urgentOverride}
          />
          <label for="urgent_override">
            Send event-driven issues immediately, ignoring the delivery
            window above.
          </label>
        </div>

        <div class="field">
          <label class="fld">Mute categories</label>
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
          <p class="hint">
            An issue is skipped for you only if <em>every</em> story in it
            falls under a muted category.
          </p>
        </div>

        <div class="field">
          <button type="submit">Save preferences</button>
        </div>
        <div class="field row-check">
          <input
            type="checkbox"
            id="unsubscribe"
            name="unsubscribe"
            value="1"
          />
          <label for="unsubscribe">
            I want to unsubscribe from Blurpadurp. (Check this box and save
            to stop receiving issues. One-click unsubscribe is also available
            in the footer of every email.)
          </label>
        </div>
      </form>
    </Layout>
  );
};
