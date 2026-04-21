import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { formatIssueDate } from "./issue.tsx";

export interface ThemeStoryRow {
  id: number;
  title: string;
  publishedAt: Date | null;
  publishedToReader: boolean;
  sourceUrl: string | null;
  oneLiner: string;
  issueId: number | null;
}

export interface ThemeViewData {
  id: number;
  name: string;
  description: string | null;
  category: string | null;
  firstSeenAt: Date;
  nStoriesPublished: number;
  stories: ThemeStoryRow[];
}

export const ThemePage: FC<{ data: ThemeViewData }> = ({ data }) => (
  <Layout
    title={`${data.name} — Blurpadurp`}
    description={
      data.description ??
      `All stories in the "${data.name}" theme on Blurpadurp.`
    }
  >
    <h2>{data.name}</h2>
    {data.description !== null ? <p>{data.description}</p> : null}
    <p class="issue-meta">
      {data.category ?? "—"} · first seen {formatIssueDate(data.firstSeenAt)} ·{" "}
      {data.nStoriesPublished} published
    </p>

    {data.stories.length === 0 ? (
      <p>
        <em>No stories attached to this theme yet.</em>
      </p>
    ) : (
      <ul class="archive-list">
        {data.stories.map((s) => (
          <li>
            <span class="date">
              {s.publishedAt ? formatIssueDate(s.publishedAt) : "no date"}
              {s.publishedToReader && s.issueId !== null
                ? ` · in issue #${s.issueId}`
                : s.publishedToReader
                  ? ""
                  : " · unpublished"}
            </span>
            <span class="title">{s.title}</span>
            {s.oneLiner ? (
              <>
                <br />
                <span style="font-size: 14px; color: var(--ink-soft);">
                  {s.oneLiner}
                </span>
              </>
            ) : null}
            {s.sourceUrl !== null ? (
              <>
                <br />
                <a href={s.sourceUrl} rel="noopener noreferrer">
                  source →
                </a>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    )}
  </Layout>
);
