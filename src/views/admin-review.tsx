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
  anchorKey: string | null;
  createdAt: Date;
}

// Walks the composed brief HTML and adds `data-anchor-id` attributes
// to every <h2> and <p> in document order. Composer output uses <p>
// (with a leading <strong>) for each item, not <li>, so paragraphs
// are the bullet-equivalent. Anchor IDs are stable for a given
// composedHtml (h2:0, h2:1, p:0, p:1, ...). Used by:
//  - the brief preview, so the click-to-comment island can detect
//    which element the cursor is on
//  - the sidebar, so notes can highlight + scroll-to their anchor
//
// We build a parallel list of "snippets" — short text previews of each
// anchor — so the sidebar can show "commenting on: Iran ceasefire is
// wobbling…" rather than the opaque key.
export interface AnchorSnippet {
  key: string;
  text: string; // ≤80 chars, plain text
}

export function decorateBriefHtml(html: string): {
  html: string;
  snippets: AnchorSnippet[];
} {
  const snippets: AnchorSnippet[] = [];
  const counters: Record<string, number> = { h2: 0, p: 0 };
  // Match opening <h2 ...> or <p ...> followed by their inner content.
  // Sonnet's tool-use HTML output is consistent enough that a regex
  // pass is reliable; full HTML parsing is overkill for this controlled
  // surface. If the regex misses a tag, we just don't anchor it.
  const out = html.replace(
    /<(h2|p)([^>]*)>([\s\S]*?)<\/\1>/g,
    (_match, tag: string, attrs: string, inner: string) => {
      const idx = counters[tag]!++;
      const key = `${tag}:${idx}`;
      const text = stripTags(inner).replace(/\s+/g, " ").trim();
      snippets.push({ key, text: text.slice(0, 80) });
      return `<${tag}${attrs} data-anchor-id="${key}">${inner}</${tag}>`;
    },
  );
  return { html: out, snippets };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

// Renderable wrapper for the annotations list. Rendered both inline by
// AdminReview (full page) and as the HTMX response fragment by the
// /admin/review/:id/annotate and /annotations/:aid/delete handlers —
// hence the standalone export. Wrapper div carries the id HTMX swaps;
// inner content groups notes by anchor and falls back to "general"
// for unanchored notes.
export const AnnotationsList: FC<{
  issueId: number;
  annotations: Annotation[];
  /** Snippets from the rendered brief, used to label anchored groups
   * with the text they're attached to. Empty when called from a
   * context that doesn't have the brief (HTMX delete fragment). */
  snippets: AnchorSnippet[];
}> = ({ issueId, annotations, snippets }) => {
  const snippetByKey = new Map(snippets.map((s) => [s.key, s.text]));
  // Group: anchored (each anchor key gets its own bucket, in snippet
  // order so the sidebar reads top-to-bottom alongside the brief),
  // general (no anchor), unresolved (anchor doesn't match any current
  // snippet — happens after re-compose).
  const byAnchor = new Map<string, Annotation[]>();
  const general: Annotation[] = [];
  const unresolved: Annotation[] = [];
  for (const a of annotations) {
    if (a.anchorKey === null) {
      general.push(a);
    } else if (snippetByKey.has(a.anchorKey)) {
      const bucket = byAnchor.get(a.anchorKey) ?? [];
      bucket.push(a);
      byAnchor.set(a.anchorKey, bucket);
    } else {
      unresolved.push(a);
    }
  }
  // Iterate snippets to preserve document order for anchored groups.
  const anchoredOrdered = snippets
    .filter((s) => byAnchor.has(s.key))
    .map((s) => ({ snippet: s, notes: byAnchor.get(s.key)! }));

  const total = annotations.length;
  return (
    <div id="annot-list-wrap">
      {total === 0 ? (
        <p style="margin: 0; color: var(--ink-soft); font-family: var(--sans); font-size: 13px;">
          No notes yet. Click any heading or bullet in the brief to attach
          a comment.
        </p>
      ) : (
        <>
          {anchoredOrdered.map((g) => (
            <NoteGroup
              issueId={issueId}
              heading={g.snippet.text || g.snippet.key}
              anchorKey={g.snippet.key}
              notes={g.notes}
            />
          ))}
          {general.length > 0 ? (
            <NoteGroup
              issueId={issueId}
              heading="General"
              anchorKey={null}
              notes={general}
            />
          ) : null}
          {unresolved.length > 0 ? (
            <NoteGroup
              issueId={issueId}
              heading="Unresolved (anchor no longer matches)"
              anchorKey={null}
              notes={unresolved}
              orphaned
            />
          ) : null}
        </>
      )}
    </div>
  );
};

const NoteGroup: FC<{
  issueId: number;
  heading: string;
  anchorKey: string | null;
  notes: Annotation[];
  orphaned?: boolean;
}> = ({ issueId, heading, anchorKey, notes, orphaned = false }) => (
  <div class={`note-group${orphaned ? " orphaned" : ""}`}>
    {anchorKey !== null ? (
      <a
        class="note-group-head note-group-head-anchored"
        href={`#anchor-${anchorKey}`}
        data-jump-anchor={anchorKey}
      >
        {heading}
      </a>
    ) : (
      <div class="note-group-head">{heading}</div>
    )}
    <ul class="annot-list">
      {notes.map((a) => (
        <li>
          <span style="color: var(--ink-soft); font-size: 12px; font-family: var(--sans);">
            {a.createdAt.toISOString().replace("T", " ").slice(0, 16)}Z
          </span>
          <p class="annot-body">{a.body}</p>
          <div class="annot-meta">
            <form
              method="post"
              action={`/admin/review/${issueId}/annotations/${a.id}/delete`}
              hx-post={`/admin/review/${issueId}/annotations/${a.id}/delete`}
              hx-target="#annot-list-wrap"
              hx-swap="outerHTML"
              hx-confirm="Delete this note?"
              data-confirm="Delete this note?"
            >
              <button type="submit">delete</button>
            </form>
          </div>
        </li>
      ))}
    </ul>
  </div>
);

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
          /* Two-column review: brief left, notes sidebar right.
             Below 1100px the sidebar drops under the brief. */
          .review-grid {
            display: grid;
            grid-template-columns: minmax(0, 1fr) 360px;
            gap: 24px;
            align-items: start;
            margin: 0 0 24px;
          }
          .review-grid > .draft-preview { margin: 0; }
          .review-grid > .annot-panel {
            margin: 0;
            position: sticky;
            top: 60px;
            max-height: calc(100vh - 80px);
            overflow-y: auto;
          }
          @media (max-width: 1100px) {
            .review-grid { grid-template-columns: minmax(0, 1fr); }
            .review-grid > .annot-panel {
              position: static; max-height: none;
            }
          }
          .annot-panel { background: #fff; border: 1px solid var(--rule); padding: 16px 18px; }
          .annot-panel h3 { margin: 0 0 10px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-soft); }
          .annot-form { display: flex; flex-direction: column; gap: 6px; margin: 0 0 14px; padding-bottom: 14px; border-bottom: 1px solid var(--rule); }
          .annot-form select, .annot-form textarea { font: inherit; font-family: var(--sans); font-size: 13px; padding: 6px 8px; border: 1px solid var(--rule); background: #fff; color: var(--ink); box-sizing: border-box; width: 100%; }
          .annot-form textarea { min-height: 64px; resize: vertical; }
          .annot-form button { align-self: flex-start; padding: 6px 12px; background: #2b4f2b; color: #fff; border: 1px solid #2b4f2b; font: inherit; font-family: var(--sans); font-size: 13px; font-weight: 600; cursor: pointer; }
          .annot-form button:hover { background: #1e3b1e; }
          .annot-target {
            font-family: var(--sans); font-size: 12px; color: var(--ink-soft);
            background: var(--paper); border: 1px solid var(--rule);
            padding: 4px 8px; display: flex; align-items: center; gap: 6px;
          }
          .annot-target.has-anchor { color: var(--ink); background: #f6f4ee; }
          .annot-target .target-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .annot-target button {
            background: transparent; border: none; padding: 0; cursor: pointer;
            color: var(--ink-soft); font: inherit; text-decoration: underline;
          }
          .annot-target button:hover { color: var(--ink); }
          .note-group { margin-top: 14px; }
          .note-group:first-child { margin-top: 0; }
          .note-group.orphaned { opacity: 0.65; }
          .note-group-head {
            font-family: var(--sans); font-size: 12px; font-weight: 600;
            color: var(--ink); margin: 0 0 6px; padding: 4px 8px;
            background: #f6f4ee; border-left: 2px solid #2b4f2b;
            display: block; text-decoration: none;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          }
          .note-group-head-anchored { cursor: pointer; }
          .note-group-head-anchored:hover { background: #ecead7; }
          /* Hover affordance on anchored elements. The cursor +
             outline communicate "click me to comment". The :hover
             pseudo handles non-JS browsers; .anchor-hover (set by
             review-notes.ts) handles browsers where event delegation
             from a child link wins over CSS :hover on the parent. */
          .draft-preview [data-anchor-id] {
            cursor: pointer;
            transition: background 0.15s ease-out;
            border-radius: 2px;
          }
          .draft-preview [data-anchor-id]:hover,
          .draft-preview [data-anchor-id].anchor-hover {
            background: #fafaf3;
            outline: 1px solid #e5e2d4;
            outline-offset: 2px;
          }
          /* Sticky highlight on the currently-selected anchor — confirms
             which element the next note will attach to. Persists until
             the operator clicks another anchor, hits "clear", or the
             form submits successfully. */
          .draft-preview [data-anchor-id].anchor-selected {
            background: #ecf3e6;
            outline: 1px solid #9bc79b;
            outline-offset: 2px;
          }
          .draft-preview [data-anchor-id].anchor-selected:hover,
          .draft-preview [data-anchor-id].anchor-selected.anchor-hover {
            background: #dfeed4;
          }
          /* Anchor highlight when scrolled into view from the sidebar. */
          .draft-preview [data-anchor-id].anchor-flash {
            background: #fff5d1 !important;
            transition: background 0.6s ease-out;
          }
          .annot-list { list-style: none; margin: 0; padding: 0; }
          .annot-list li { border-top: 1px solid var(--rule); padding: 8px 0; }
          .annot-list li:first-child { border-top: 0; padding-top: 0; }
          .annot-slot { display: inline-block; font-family: var(--sans); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; background: var(--paper); border: 1px solid var(--rule); padding: 1px 6px; margin-right: 6px; color: var(--ink-soft); }
          .annot-body { margin: 4px 0 0; white-space: pre-wrap; font-size: 13px; line-height: 1.45; }
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
    <AdminNav
      current="issues"
      clientBundles={["/assets/build/review-notes.js"]}
    />
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
    {(() => {
      const decorated = decorateBriefHtml(data.issue.composedHtml);
      return (
        <div class="review-grid">
          <section class="draft-preview" aria-label="Rendered brief">
            <div dangerouslySetInnerHTML={{ __html: decorated.html }} />
          </section>
          <aside class="annot-panel" aria-label="Review notes" id="notes">
            <h3>Review notes</h3>
            <form
              method="post"
              action={`/admin/review/${data.issue.id}/annotate`}
              hx-post={`/admin/review/${data.issue.id}/annotate`}
              hx-target="#annot-list-wrap"
              hx-swap="outerHTML"
              hx-on--after-request="if (event.detail.successful) { this.reset(); var t=this.querySelector('input[name=anchor_key]'); if(t) t.value=''; var ind=this.querySelector('.annot-target'); if(ind){ind.classList.remove('has-anchor');var span=ind.querySelector('.target-text'); if(span) span.textContent='General comment'; } this.querySelector('textarea').focus(); }"
              class="annot-form"
            >
              <div class="annot-target" data-target-indicator>
                <span class="target-text">General comment</span>
                <button
                  type="button"
                  data-clear-anchor
                  title="Switch back to a general comment"
                >
                  clear
                </button>
              </div>
              <input type="hidden" name="anchor_key" value="" />
              <textarea
                name="body"
                placeholder="What's working, what's not, what to try next time…"
                required
              />
              <button type="submit">Add note</button>
            </form>
            <AnnotationsList
              issueId={data.issue.id}
              annotations={data.annotations}
              snippets={decorated.snippets}
            />
          </aside>
        </div>
      );
    })()}
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
