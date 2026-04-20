import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";

export const TokenResultPage: FC<{
  title: string;
  body: string;
  error?: boolean;
}> = ({ title, body, error = false }) => (
  <Layout title={`${title} — Blurpadurp`}>
    <div class={`flash ${error ? "error" : ""}`}>{body}</div>
    <p>
      <a href="/">← Back to the latest issue</a>
    </p>
  </Layout>
);
