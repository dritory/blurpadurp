import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { IssueBody, type IssueView, formatIssueDate, issueLabel } from "./issue.tsx";

export type Flash = { kind: "ok" | "error"; msg: string } | null;

// Three home-page states: the latest issue is fresh, the latest issue
// is older than home.staleness_threshold_days (silence), or no issue
// has ever published. The silence panel deep-links the most recent
// back issue so the page isn't a dead end.
export type HomeViewData =
  | { kind: "issue"; issue: IssueView }
  | {
      kind: "silent";
      lastIssue: {
        id: number;
        publishedSeq: number | null;
        publishedAt: Date;
        title: string | null;
      };
    }
  | { kind: "empty" };

export const Home: FC<{ home: HomeViewData; flash: Flash }> = ({
  home,
  flash,
}) => (
  <Layout title="Blurpadurp" nav="home">
    {flash !== null ? (
      <div class={`flash ${flash.kind === "error" ? "error" : ""}`}>
        {flash.msg}
      </div>
    ) : null}
    {home.kind === "issue" ? (
      <IssueBody issue={home.issue} />
    ) : home.kind === "silent" ? (
      <SilencePanel last={home.lastIssue} />
    ) : (
      <p>
        <em>No issues yet. Blurp hasn't found anything worth sending.</em>
      </p>
    )}
  </Layout>
);

const SilencePanel: FC<{
  last: {
    id: number;
    publishedSeq: number | null;
    publishedAt: Date;
    title: string | null;
  };
}> = ({ last }) => (
  <article class="issue-body">
    <div class="issue-meta">Quiet week.</div>
    <p>
      <em>Nothing rose above the noise. Back when something does.</em>
    </p>
    <p style="margin-top: 1.5em;">
      The last brief is still here:{" "}
      <a href={`/issue/${last.id}`}>
        {last.title ?? issueLabel(last)}
      </a>{" "}
      <span style="color: var(--ink-soft);">
        · {formatIssueDate(last.publishedAt)}
      </span>.
      Older issues live in the <a href="/archive">archive</a>.
    </p>
  </article>
);
