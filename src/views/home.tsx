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
    {latest !== null ? (
      <IssueBody issue={latest} />
    ) : (
      <p>
        <em>No issues yet. Blurp hasn't found anything worth sending.</em>
      </p>
    )}
  </Layout>
);
