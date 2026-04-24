// Admin editor-review page. Shows what the editor picked, what it cut,
// and the shrug candidates the composer saw. Meant for the operator's
// tuning loop: "why did this story miss?", "is the shrug pool right?"

import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { AdminCrumbs, AdminNav } from "./admin-nav.tsx";
import { formatIssueDate } from "./issue.tsx";

export interface Annotation {
  id: number;
  slot: string;
  body: string;
  createdAt: Date;
}

function slotLabel(slot: string): string {
  switch (slot) {
    case "summary":
      return "Overall";
    case "opener":
      return "Opener";
    case "conversation":
      return "Conversation";
    case "worth_knowing":
      return "Worth knowing";
    case "worth_watching":
      return "Worth watching";
    case "shrug":
      return "Shrug";
    default:
      return slot;
  }
}

export interface EditorReviewData {
  issue: {
    id: number;
    publishedAt: Date;
    isEventDriven: boolean;
    isDraft: boolean;
    composerPromptVersion: string | null;
    composerModelId: string | null;
    composedHtml: string;
  };
  annotations: Annotation[];
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
  flash: { kind: "ok"; msg: string } | { kind: "err"; msg: string } | null;
}> = ({ data, replays, editorReplays, flash }) => (
  <Layout title={`Review #${data.issue.id} — Blurpadurp`}>
    <style
      dangerouslySetInnerHTML={{
        __html: `
          .action-bar { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; font-family: var(--sans); font-size: 13px; }
          .action-bar a, .action-bar button { padding: 5px 10px; border: 1px solid var(--rule); background: #fff; color: var(--ink); text-decoration: none; font: inherit; cursor: pointer; }
          .action-bar a:hover, .action-bar button:hover { border-color: var(--ink); }
          .action-bar .cli { color: var(--ink-soft); padding: 5px 10px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
          .action-bar form { display: inline; }
          .action-bar button.publish { background: #2b4f2b; color: #fff; border-color: #2b4f2b; font-weight: 600; }
          .action-bar button.publish:hover { background: #1e3b1e; }
          .action-bar button.discard { color: #8a2a2a; border-color: #d4a4a4; }
          .action-bar button.discard:hover { background: #fbeeee; border-color: #8a2a2a; }
          .draft-banner { background: #fff5d1; border: 1px solid #d4b84a; color: #6a5200; padding: 10px 14px; margin: 0 0 16px; font-family: var(--sans); font-size: 14px; }
          .draft-banner strong { font-weight: 700; }
          .flash { padding: 10px 14px; margin: 0 0 16px; font-family: var(--sans); font-size: 14px; border: 1px solid var(--rule); }
          .flash.ok { background: #e6f3e6; border-color: #9bc79b; color: #2b4f2b; }
          .flash.err { background: #fbeeee; border-color: #d4a4a4; color: #8a2a2a; }
          .annot-panel { background: #fff; border: 1px solid var(--rule); padding: 18px 20px; margin: 24px 0 0; }
          .annot-panel h3 { margin: 0 0 12px; font-size: 16px; }
          .annot-form { display: flex; flex-direction: column; gap: 8px; margin: 0 0 18px; }
          .annot-form select, .annot-form textarea { font: inherit; font-family: var(--sans); font-size: 14px; padding: 8px 10px; border: 1px solid var(--rule); background: #fff; color: var(--ink); box-sizing: border-box; width: 100%; }
          .annot-form textarea { min-height: 80px; resize: vertical; }
          .annot-form button { align-self: flex-start; padding: 7px 14px; background: #2b4f2b; color: #fff; border: 1px solid #2b4f2b; font: inherit; font-family: var(--sans); font-size: 13px; font-weight: 600; cursor: pointer; }
          .annot-form button:hover { background: #1e3b1e; }
          .annot-list { list-style: none; margin: 0; padding: 0; }
          .annot-list li { border-top: 1px solid var(--rule); padding: 10px 0; }
          .annot-list li:first-child { border-top: 0; padding-top: 0; }
          .annot-slot { display: inline-block; font-family: var(--sans); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; background: var(--paper); border: 1px solid var(--rule); padding: 1px 6px; margin-right: 6px; color: var(--ink-soft); }
          .annot-body { margin: 4px 0 0; white-space: pre-wrap; font-size: 14px; line-height: 1.5; }
          .annot-meta { font-family: var(--sans); font-size: 12px; color: var(--ink-soft); margin: 4px 0 0; }
          .annot-meta form { display: inline; }
          .annot-meta button { background: transparent; border: none; color: #8a2a2a; cursor: pointer; font: inherit; padding: 0; text-decoration: underline; }
          .annot-meta button:hover { color: #5a1a1a; }
          .draft-preview { background: #fff; border: 1px solid var(--rule); padding: 20px 24px; margin: 0 0 24px; }
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
    {data.issue.isDraft ? (
      <div class="draft-banner">
        <strong>Draft</strong> — not visible to readers. Publish sends at the
        next hourly dispatch.
      </div>
    ) : null}
    {flash !== null ? (
      <div class={`flash ${flash.kind}`}>{flash.msg}</div>
    ) : null}
    <nav class="action-bar" aria-label="Actions">
      {data.issue.isDraft ? (
        <>
          <form
            method="post"
            action={`/admin/review/${data.issue.id}/publish`}
            data-confirm="Publish this draft? It will be visible immediately and sent at the next hourly dispatch."
          >
            <button type="submit" class="publish">Publish</button>
          </form>
          <form
            method="post"
            action={`/admin/review/${data.issue.id}/recompose`}
            data-confirm="Re-run the composer on the same picks? Overwrites the rendered brief."
          >
            <button type="submit">Re-compose</button>
          </form>
          <form
            method="post"
            action={`/admin/review/${data.issue.id}/reedit`}
            data-confirm="Re-run editor + composer from scratch? Replaces picks entirely."
          >
            <button type="submit">Re-edit</button>
          </form>
          <form
            method="post"
            action={`/admin/review/${data.issue.id}/discard`}
            data-confirm="Discard this draft? Stories return to the pool."
          >
            <button type="submit" class="discard">Discard</button>
          </form>
        </>
      ) : (
        <a href={`/issue/${data.issue.id}`}>View published</a>
      )}
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
    <section class="draft-preview" aria-label="Rendered brief">
      <div dangerouslySetInnerHTML={{ __html: data.issue.composedHtml }} />
    </section>
    <script src="/assets/admin-review.js" defer />


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

    <section class="annot-panel" aria-label="Review notes" id="notes">
      <h3>Review notes</h3>
      <form
        method="post"
        action={`/admin/review/${data.issue.id}/annotate`}
        class="annot-form"
      >
        <select name="slot">
          <option value="summary">Overall</option>
          <option value="opener">Opener</option>
          <option value="conversation">Conversation</option>
          <option value="worth_knowing">Worth knowing</option>
          <option value="worth_watching">Worth watching</option>
          <option value="shrug">Shrug</option>
        </select>
        <textarea
          name="body"
          placeholder="What's working, what's not, what to try next time…"
          required
        />
        <button type="submit">Add note</button>
      </form>
      {data.annotations.length === 0 ? (
        <p style="margin: 0; color: var(--ink-soft); font-family: var(--sans); font-size: 13px;">
          No notes yet.
        </p>
      ) : (
        <ul class="annot-list">
          {data.annotations.map((a) => (
            <li>
              <span class="annot-slot">{slotLabel(a.slot)}</span>
              <span style="color: var(--ink-soft); font-size: 12px; font-family: var(--sans);">
                {a.createdAt.toISOString().replace("T", " ").slice(0, 16)}Z
              </span>
              <p class="annot-body">{a.body}</p>
              <div class="annot-meta">
                <form
                  method="post"
                  action={`/admin/review/${data.issue.id}/annotations/${a.id}/delete`}
                  data-confirm="Delete this note?"
                >
                  <button type="submit">delete</button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>

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
