import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { formatIssueDate, issueLabel } from "./issue.tsx";

export interface ArchiveEntry {
  id: number;
  publishedSeq: number | null;
  publishedAt: Date;
  isEventDriven: boolean;
  title: string | null;
}

export const Archive: FC<{ issues: ArchiveEntry[] }> = ({ issues }) => (
  <Layout title="Archive — Blurpadurp" nav="archive">
    <h2>Archive</h2>
    {issues.length === 0 ? (
      <p>
        <em>No issues yet. Blurp hasn't found anything worth sending.</em>
      </p>
    ) : (
      <ul class="archive-list">
        {issues.map((iss) => (
          <li>
            <a href={`/issue/${iss.id}`}>
              <span class="date">
                {formatIssueDate(iss.publishedAt)}
                {iss.isEventDriven ? " · event-driven" : ""}
              </span>
              <span class="title">
                {iss.title ?? issueLabel(iss)}
              </span>
            </a>
          </li>
        ))}
      </ul>
    )}
  </Layout>
);
