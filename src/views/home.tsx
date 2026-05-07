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
    <div class="issue-meta">{formatIssueDate(new Date())}</div>
    <h1 class="issue-title">Quiet week.</h1>
    <p>
      <em>Blurp didn't find anything worth sending.</em>
    </p>
    <div style="margin-top: 3em;">
      <p style="margin: 0; color: var(--ink-soft); font-family: var(--sans); font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em;">
        Last brief
      </p>
      <p style="margin: 6px 0 0;">
        <a href={`/issue/${last.id}`}>
          {last.title ?? issueLabel(last)}
        </a>
      </p>
      <p style="margin: 2px 0 0; color: var(--ink-soft); font-size: 14px;">
        {formatIssueDate(last.publishedAt)}
      </p>
    </div>
    <p style="margin-top: 1.5em;">
      Older issues are in the <a href="/archive">archive</a>.
    </p>
  </article>
);
