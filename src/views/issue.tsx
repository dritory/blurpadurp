import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { sanitizeBriefHtml } from "../shared/sanitize-html.ts";

export interface IssueView {
  id: number;
  publishedSeq: number | null;
  publishedAt: Date;
  isEventDriven: boolean;
  title: string | null;
  html: string;
}

// Reader-facing issue label. `published_seq` is gap-free (drafts don't
// burn numbers); fall back to the surrogate id only for issues
// pre-dating migration 041 that somehow weren't backfilled.
export function issueLabel(issue: { id: number; publishedSeq: number | null }): string {
  return `Issue #${issue.publishedSeq ?? issue.id}`;
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
      {issueLabel(issue)} · {formatIssueDate(issue.publishedAt)}
      {issue.isEventDriven ? " · event-driven" : ""}
    </div>
    {issue.title !== null ? (
      <h1 class="issue-title">{issue.title}</h1>
    ) : null}
    <div dangerouslySetInnerHTML={{ __html: sanitizeBriefHtml(issue.html) }} />
  </article>
);

export const IssuePage: FC<{ issue: IssueView }> = ({ issue }) => (
  <Layout
    title={`${issue.title ?? issueLabel(issue)} — Blurpadurp`}
    nav="archive"
  >
    <IssueBody issue={issue} />
  </Layout>
);
