import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";

export interface IssueView {
  id: number;
  publishedAt: Date;
  isEventDriven: boolean;
  title: string | null;
  html: string;
}

export function formatIssueDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export const IssueBody: FC<{ issue: IssueView }> = ({ issue }) => (
  <article class="issue-body">
    <div class="issue-meta">
      Issue #{issue.id} · {formatIssueDate(issue.publishedAt)}
      {issue.isEventDriven ? " · event-driven" : ""}
    </div>
    {issue.title !== null ? (
      <h1 class="issue-title">{issue.title}</h1>
    ) : null}
    <div dangerouslySetInnerHTML={{ __html: issue.html }} />
  </article>
);

export const IssuePage: FC<{ issue: IssueView }> = ({ issue }) => (
  <Layout
    title={`${issue.title ?? `Issue #${issue.id}`} — Blurpadurp`}
    nav="archive"
  >
    <IssueBody issue={issue} />
  </Layout>
);
