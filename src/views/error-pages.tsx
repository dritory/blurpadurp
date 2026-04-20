import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";

export const NotFoundPage: FC = () => (
  <Layout title="Not found — Blurpadurp">
    <h2>Not found</h2>
    <p>
      No page at this URL. The brief publishes when it publishes —
      individual URLs don't go missing, so this is probably a typo.
    </p>
    <p>
      <a href="/">← Latest issue</a> · <a href="/archive">Archive</a>
    </p>
  </Layout>
);

export const ServerErrorPage: FC<{ detail?: string }> = ({ detail }) => (
  <Layout title="Something broke — Blurpadurp">
    <h2>Something broke on our end</h2>
    <p>
      Nothing you can do from here. The operator sees this too and will
      fix it. Try again in a bit.
    </p>
    {detail !== undefined ? (
      <pre
        style="background: #fff; border: 1px solid var(--rule); padding: 10px; font-size: 12px; overflow: auto;"
      >
        {detail}
      </pre>
    ) : null}
    <p>
      <a href="/">← Latest issue</a>
    </p>
  </Layout>
);
