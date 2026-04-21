import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { IssueBody, type IssueView } from "./issue.tsx";

export type Flash = { kind: "ok" | "error"; msg: string } | null;

export const Home: FC<{ latest: IssueView | null; flash: Flash }> = ({
  latest,
  flash,
}) => (
  <Layout title="Blurpadurp" nav="home">
    {flash !== null ? (
      <div class={`flash ${flash.kind === "error" ? "error" : ""}`}>
        {flash.msg}
      </div>
    ) : null}
    <form class="subscribe" method="post" action="/subscribe">
      <label for="email">
        Subscribe — one brief a week, or nothing. No account. No tracking.
      </label>
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
        We confirm the address later, when dispatch is live. You can
        unsubscribe from any issue.
      </p>
    </form>
    {latest !== null ? (
      <IssueBody issue={latest} />
    ) : (
      <p>
        <em>No issues yet. The gate has not fired.</em>
      </p>
    )}
  </Layout>
);
