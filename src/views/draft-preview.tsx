import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import {
  type Annotation,
  decorateBriefHtml,
} from "./admin-review.tsx";
import { formatIssueDate } from "./issue.tsx";

// Reviewer-facing draft preview, reached via a signed magic-link
// (kind=draft-preview, see src/shared/tokens.ts). The token holder
// gets a read-only render of the draft plus a feedback form that
// writes to issue_annotation with reviewer_name set. No admin auth,
// no admin actions, no edit-body.
//
// Reuses decorateBriefHtml so anchor click-to-comment behaves the
// same as the admin page, and reuses /assets/build/review-notes.js
// for the client island. The form posts via standard POST (no HTMX)
// and the server redirects back to this page.

export interface DraftPreviewData {
  issue: {
    id: number;
    publishedAt: Date;
    title: string | null;
    composedHtml: string;
  };
  reviewerName: string;
  token: string;
  annotations: Annotation[];
}

export const DraftPreview: FC<{
  data: DraftPreviewData;
  flash: { kind: "ok"; msg: string } | { kind: "err"; msg: string } | null;
}> = ({ data, flash }) => {
  const decorated = decorateBriefHtml(data.issue.composedHtml);
  const submitUrl = `/draft/${data.issue.id}/notes?token=${encodeURIComponent(data.token)}`;
  const reloadUrl = `/draft/${data.issue.id}?token=${encodeURIComponent(data.token)}`;
  return (
    <Layout title={`Draft preview — Blurpadurp`} nav={null}>
      <style
        dangerouslySetInnerHTML={{
          __html: DRAFT_PREVIEW_STYLES,
        }}
      />
      <div class="preview-banner">
        <strong>Draft preview</strong> · reviewing as <em>{data.reviewerName}</em>.
        Click any heading or paragraph in the brief to attach a comment.
        Notes are saved with your name and will be visible to the editor.
      </div>
      {flash !== null ? (
        <div class={`flash ${flash.kind === "err" ? "error" : ""}`}>
          {flash.msg}
        </div>
      ) : null}
      <div class="issue-meta">
        Draft · {formatIssueDate(data.issue.publishedAt)}
      </div>
      {data.issue.title !== null ? (
        <h1 class="issue-title">{data.issue.title}</h1>
      ) : null}
      <div class="review-grid">
        <section class="draft-preview" aria-label="Rendered brief">
          <div dangerouslySetInnerHTML={{ __html: decorated.html }} />
        </section>
        <aside class="annot-panel" aria-label="Your notes" id="notes">
          <h3>Your feedback</h3>
          <form method="post" action={submitUrl} class="annot-form">
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
              placeholder="What's working, what's not, what's confusing…"
              required
            />
            <button type="submit">Add note</button>
          </form>
          <ReviewerNotesList
            reviewerName={data.reviewerName}
            annotations={data.annotations}
            reloadUrl={reloadUrl}
            snippetByKey={new Map(decorated.snippets.map((s) => [s.key, s.text]))}
          />
        </aside>
      </div>
      <p class="preview-footer">
        A read-only preview of an unpublished draft. The published version may differ.
        <br />
        <a href={reloadUrl}>Refresh to see updates</a>
      </p>
      <script src="/assets/build/review-notes.js" defer></script>
    </Layout>
  );
};

const ReviewerNotesList: FC<{
  reviewerName: string;
  annotations: Annotation[];
  reloadUrl: string;
  snippetByKey: Map<string, string>;
}> = ({ reviewerName, annotations, reloadUrl, snippetByKey }) => {
  // Show only this reviewer's notes back to them. Admin notes and
  // notes from other reviewers stay private to the admin sidebar —
  // a reviewer doesn't need to see editorial deliberations.
  const own = annotations.filter((a) => a.reviewerName === reviewerName);
  if (own.length === 0) {
    return (
      <p class="annot-empty">
        No notes yet. Click any heading or paragraph in the brief to attach a comment.
      </p>
    );
  }
  return (
    <ul class="annot-list">
      {own.map((a) => {
        const anchorText =
          a.anchorKey !== null ? snippetByKey.get(a.anchorKey) : null;
        return (
          <li>
            <div class="annot-anchor-label">
              {a.anchorKey === null
                ? "General"
                : anchorText !== undefined
                  ? anchorText
                  : "(no longer matches)"}
            </div>
            <p class="annot-body">{a.body}</p>
            <div class="annot-meta">
              {a.createdAt.toISOString().replace("T", " ").slice(0, 16)}Z
            </div>
          </li>
        );
      })}
    </ul>
  );
};

const DRAFT_PREVIEW_STYLES = `
  .preview-banner {
    background: #fff5d1; border: 1px solid #d4b84a; color: #6a5200;
    padding: 10px 14px; margin: 0 0 16px;
    font-family: var(--sans); font-size: 14px; line-height: 1.45;
  }
  .preview-banner strong { font-weight: 700; }
  .preview-banner em { font-style: italic; color: #4a3800; }
  .flash {
    padding: 10px 14px; margin: 0 0 16px; font-family: var(--sans);
    font-size: 14px; border: 1px solid var(--rule); background: #e6f3e6;
    border-color: #9bc79b; color: #2b4f2b;
  }
  .flash.error { background: #fbeeee; border-color: #d4a4a4; color: #8a2a2a; }
  .issue-meta {
    font-family: var(--sans); font-size: 13px; color: var(--ink-soft);
    margin: 0 0 6px;
  }
  .issue-title { margin: 0 0 18px; }
  .preview-footer {
    margin-top: 32px; padding-top: 12px; border-top: 1px solid var(--rule);
    font-family: var(--sans); font-size: 12px; color: var(--ink-soft);
  }
  .review-grid {
    display: grid; grid-template-columns: minmax(0, 1fr) 320px;
    gap: 24px; align-items: start; margin: 0 0 24px;
  }
  @media (max-width: 900px) {
    .review-grid { grid-template-columns: 1fr; }
  }
  .draft-preview {
    background: #fff; border: 1px solid var(--rule);
    padding: 20px 24px; margin: 0;
  }
  .draft-preview [data-anchor-id] {
    cursor: pointer; transition: background 0.15s ease-out; border-radius: 2px;
  }
  .draft-preview [data-anchor-id]:hover,
  .draft-preview [data-anchor-id].anchor-hover {
    background: #fafaf3; outline: 1px solid #e5e2d4; outline-offset: 2px;
  }
  .draft-preview [data-anchor-id].anchor-selected {
    background: #ecf3e6; outline: 1px solid #9bc79b; outline-offset: 2px;
  }
  .draft-preview [data-anchor-id].anchor-selected:hover,
  .draft-preview [data-anchor-id].anchor-selected.anchor-hover {
    background: #dfeed4;
  }
  .draft-preview [data-anchor-id].anchor-flash {
    background: #fff5d1 !important; transition: background 0.6s ease-out;
  }
  .annot-panel {
    position: sticky; top: 16px;
    background: #fff; border: 1px solid var(--rule);
    padding: 14px; max-height: calc(100vh - 32px); overflow-y: auto;
  }
  .annot-panel h3 {
    margin: 0 0 10px; font-family: var(--sans); font-size: 13px;
    font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--ink-soft);
  }
  .annot-form { display: flex; flex-direction: column; gap: 8px; margin: 0 0 16px; }
  .annot-form textarea {
    font: inherit; font-family: var(--serif); font-size: 14px;
    padding: 8px 10px; border: 1px solid var(--rule); background: #fff;
    color: var(--ink); width: 100%; box-sizing: border-box;
    min-height: 90px; resize: vertical; line-height: 1.45;
  }
  .annot-form button[type=submit] {
    padding: 6px 12px; background: #2b4f2b; color: #fff; border: 1px solid #2b4f2b;
    font: inherit; font-family: var(--sans); font-size: 13px; font-weight: 600;
    cursor: pointer; align-self: flex-start;
  }
  .annot-form button[type=submit]:hover { background: #1e3b1e; }
  .annot-target {
    font-family: var(--sans); font-size: 12px; color: var(--ink-soft);
    background: var(--paper); border: 1px solid var(--rule);
    padding: 4px 8px; display: flex; align-items: center; gap: 6px;
  }
  .annot-target.has-anchor { color: var(--ink); background: #f6f4ee; }
  .annot-target .target-text {
    flex: 1; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  .annot-target button {
    background: transparent; border: none; padding: 0; cursor: pointer;
    color: var(--ink-soft); font: inherit; text-decoration: underline;
  }
  .annot-target button:hover { color: var(--ink); }
  .annot-empty {
    margin: 0; color: var(--ink-soft); font-family: var(--sans); font-size: 13px;
  }
  .annot-list { list-style: none; margin: 0; padding: 0; }
  .annot-list li { border-top: 1px solid var(--rule); padding: 8px 0; }
  .annot-list li:first-child { border-top: 0; padding-top: 0; }
  .annot-anchor-label {
    font-family: var(--sans); font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--ink-soft); margin: 0 0 4px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .annot-body { margin: 0; white-space: pre-wrap; font-size: 13px; line-height: 1.45; }
  .annot-meta {
    font-family: var(--sans); font-size: 11px; color: var(--ink-soft); margin: 4px 0 0;
  }
`;
