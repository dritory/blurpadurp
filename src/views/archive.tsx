import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { formatIssueDate } from "./issue.tsx";

export interface ArchiveEntry {
  id: number;
  publishedAt: Date;
  isEventDriven: boolean;
}

export const Archive: FC<{ issues: ArchiveEntry[] }> = ({ issues }) => (
  <Layout title="Archive — Blurpadurp" nav="archive">
    <h2>Archive</h2>
    {issues.length === 0 ? (
      <p>
        <em>No issues yet. The gate has not fired.</em>
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
              <span class="title">Issue #{iss.id}</span>
            </a>
          </li>
        ))}
      </ul>
    )}
  </Layout>
);
