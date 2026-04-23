// Admin editor-review page. Shows what the editor picked, what it cut,
// and the shrug candidates the composer saw. Meant for the operator's
// tuning loop: "why did this story miss?", "is the shrug pool right?"

import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { AdminCrumbs, AdminNav } from "./admin-nav.tsx";
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
    picks: Array<
      | { story_id: number; rank: number; reason: string }
      | {
          story_ids: number[];
          lead_story_id: number;
          rank: number;
          reason: string;
        }
    >;
    cuts_summary: string;
  } | null;
  storyTitles: Map<number, string>;
  storyThemes: Map<
    number,
    { theme_id: number | null; theme_name: string | null }
  >;
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

export const AdminReview: FC<{
  data: EditorReviewData;
  replays: Array<{ base: string; mtime: Date }>;
  editorReplays: Array<{ base: string; mtime: Date }>;
}> = ({ data, replays, editorReplays }) => (
  <Layout title={`Review #${data.issue.id} — Blurpadurp`}>
    <style
      dangerouslySetInnerHTML={{
        __html: `
          .action-bar { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; font-family: var(--sans); font-size: 13px; }
          .action-bar a { padding: 5px 10px; border: 1px solid var(--rule); background: #fff; color: var(--ink); text-decoration: none; }
          .action-bar a:hover { border-color: var(--ink); }
          .action-bar .cli { color: var(--ink-soft); padding: 5px 10px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
          .editor-bar { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 20px; font-family: var(--sans); font-size: 13px; align-items: center; }
          .editor-bar a { padding: 5px 10px; border: 1px solid var(--rule); background: #fff; color: var(--ink); text-decoration: none; }
          .editor-bar a:hover { border-color: var(--ink); }
          .editor-bar .cli { color: var(--ink-soft); padding: 5px 10px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
          .editor-bar .label { color: var(--ink-soft); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
        `,
      }}
    />
    <AdminNav current="issues" />
    <AdminCrumbs
      trail={[
        { label: "Issues", href: "/admin/issues" },
        { label: `#${data.issue.id} review` },
      ]}
    />
    <div class="issue-meta">
      Issue #{data.issue.id} · {formatIssueDate(data.issue.publishedAt)}
      {data.issue.isEventDriven ? " · event-driven" : ""}
      {" · "}
      {data.issue.composerPromptVersion ?? "unknown"} /{" "}
      {data.issue.composerModelId ?? "unknown"}
    </div>
    <nav class="action-bar" aria-label="Actions">
      <a href={`/issue/${data.issue.id}`}>View published</a>
      {replays.length > 0 ? (
        <>
          <a href={`/admin/fixtures/${replays[0]!.base}.diff.md`}>
            Latest replay (diff)
          </a>
          <a href={`/admin/fixtures/${replays[0]!.base}.html`}>
            Rendered brief
          </a>
          <a href="/admin/fixtures">All replays ({replays.length})</a>
        </>
      ) : (
        <span class="cli">bun run cli composer-replay {data.issue.id}</span>
      )}
    </nav>

    <h2>Editor picks</h2>
    <nav class="editor-bar" aria-label="Editor replay actions">
      <span class="label">Editor replay:</span>
      {editorReplays.length > 0 ? (
        <>
          <a href={`/admin/fixtures/${editorReplays[0]!.base}.diff.md`}>
            Latest (diff)
          </a>
          <a href="/admin/fixtures">All ({editorReplays.length})</a>
        </>
      ) : (
        <span class="cli">bun run cli editor-replay {data.issue.id}</span>
      )}
    </nav>
    {data.editor === null ? (
      <p><em>No editor output persisted for this issue.</em></p>
    ) : (
      <>
        <ol>
          {data.editor.picks
            .slice()
            .sort((a, b) => a.rank - b.rank)
            .map((p) => {
              const isArc = "story_ids" in p;
              const ids = isArc ? p.story_ids : [p.story_id];
              const lead = isArc ? p.lead_story_id : p.story_id;
              const leadTheme = data.storyThemes.get(lead);
              return (
                <li>
                  <strong>
                    <a href={`/issue/${data.issue.id}`}>
                      {data.storyTitles.get(lead) ?? `story #${lead}`}
                    </a>
                  </strong>
                  {isArc ? (
                    <span
                      style="font-family: var(--sans); font-size: 11px; background: rgba(74, 107, 74, 0.15); color: #2b4f2b; padding: 1px 6px; border-radius: 2px; margin-left: 8px;"
                    >
                      arc · {ids.length} stories
                    </span>
                  ) : null}
                  <br />
                  <span style="color: var(--ink-soft); font-size: 14px;">
                    rank {p.rank} — {p.reason}
                  </span>
                  <br />
                  <span style="color: var(--ink-soft); font-size: 12px; font-family: var(--sans);">
                    theme:{" "}
                    {leadTheme?.theme_name !== null && leadTheme?.theme_name !== undefined ? (
                      <>
                        <a href={`/theme/${leadTheme.theme_id}`}>
                          {leadTheme.theme_name}
                        </a>{" "}
                        <span style="opacity: 0.6;">#{leadTheme.theme_id}</span>
                      </>
                    ) : (
                      <em>none</em>
                    )}
                  </span>
                  {isArc && ids.length > 1 ? (
                    <ul
                      style="font-family: var(--sans); font-size: 12px; color: var(--ink-soft); margin: 4px 0 0 20px; padding: 0; list-style: disc;"
                    >
                      {ids.map((sid) => {
                        const t = data.storyThemes.get(sid);
                        return (
                          <li>
                            #{sid} — {data.storyTitles.get(sid) ?? "(missing title)"}{" "}
                            {t?.theme_name !== null && t?.theme_name !== undefined ? (
                              <span style="opacity: 0.8;">
                                · theme {t.theme_name} (#{t.theme_id})
                              </span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </li>
              );
            })}
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
