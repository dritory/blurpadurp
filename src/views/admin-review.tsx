// Admin editor-review page. Shows what the editor picked, what it cut,
// and the shrug candidates the composer saw. Meant for the operator's
// tuning loop: "why did this story miss?", "is the shrug pool right?"

import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { AdminNav } from "./admin-nav.tsx";
import { formatIssueDate } from "./issue.tsx";

export interface EditorReviewData {
  issue: {
    id: number;
    publishedAt: Date;
    isEventDriven: boolean;
    composerPromptVersion: string | null;
    composerModelId: string | null;
  };
  editor: {
    picks: Array<{ story_id: number; rank: number; reason: string }>;
    cuts_summary: string;
  } | null;
  storyTitles: Map<number, string>;
  shrug: Array<{
    story_id: number;
    title: string;
    source_url: string | null;
    category: string | null;
    penalty_factors: string[];
    source_count: number;
    scorer_one_liner: string;
  }>;
}

export const AdminReview: FC<{ data: EditorReviewData }> = ({ data }) => (
  <Layout title={`Review #${data.issue.id} — Blurpadurp`}>
    <AdminNav current={null} />
    <div class="issue-meta">
      Issue #{data.issue.id} · {formatIssueDate(data.issue.publishedAt)}
      {data.issue.isEventDriven ? " · event-driven" : ""}
      {" · "}
      {data.issue.composerPromptVersion ?? "unknown"} /{" "}
      {data.issue.composerModelId ?? "unknown"}
    </div>

    <h2>Editor picks</h2>
    {data.editor === null ? (
      <p><em>No editor output persisted for this issue.</em></p>
    ) : (
      <>
        <ol>
          {data.editor.picks
            .slice()
            .sort((a, b) => a.rank - b.rank)
            .map((p) => (
              <li>
                <strong>
                  <a href={`/issue/${data.issue.id}`}>
                    {data.storyTitles.get(p.story_id) ?? `story #${p.story_id}`}
                  </a>
                </strong>
                <br />
                <span style="color: var(--ink-soft); font-size: 14px;">
                  rank {p.rank} — {p.reason}
                </span>
              </li>
            ))}
        </ol>
        <h3>What the editor cut</h3>
        <p>{data.editor.cuts_summary || <em>— no cuts summary —</em>}</p>
      </>
    )}

    <h2>Shrug pool</h2>
    {data.shrug.length === 0 ? (
      <p>
        <em>No shrug candidates for this issue.</em>
      </p>
    ) : (
      <ul>
        {data.shrug.map((s) => (
          <li>
            <strong>{s.title}</strong>
            <br />
            <span style="color: var(--ink-soft); font-size: 14px;">
              {s.category ?? "—"} ·{" "}
              {s.penalty_factors.join(", ") || "no factors"} ·{" "}
              {s.source_count} sources
            </span>
            <br />
            <span style="font-size: 14px;">{s.scorer_one_liner}</span>
          </li>
        ))}
      </ul>
    )}
  </Layout>
);
