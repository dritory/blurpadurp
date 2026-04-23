import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import type { Flash } from "./home.tsx";

export const SubscribePage: FC<{ flash: Flash }> = ({ flash }) => (
  <Layout title="Subscribe — Blurpadurp" nav="subscribe">
    <h2 style="margin-top: 0;">Subscribe</h2>
    <p>
      One brief a week when the gate fires, nothing otherwise. No account, no
      tracking, no password. Unsubscribe from any issue.
    </p>
    {flash !== null ? (
      <div class={`flash ${flash.kind === "error" ? "error" : ""}`}>
        {flash.msg}
      </div>
    ) : null}
    <form class="subscribe" method="post" action="/subscribe">
      <label for="email">Email address</label>
      <div class="row">
        <input
          type="email"
          name="email"
          id="email"
          placeholder="you@example.com"
          required
          autocomplete="email"
        />
        <button type="submit">Subscribe</button>
      </div>
      <input
        type="text"
        name="company"
        class="hp"
        tabindex={-1}
        autocomplete="off"
        aria-hidden="true"
      />
      <p class="fine">
        We confirm the address later, when dispatch is live. You can unsubscribe
        from any issue.
      </p>
    </form>
  </Layout>
);
