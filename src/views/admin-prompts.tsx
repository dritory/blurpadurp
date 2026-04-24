// Admin prompt editor. Lets the operator stage a composer or editor
// prompt in the DB for draft re-compose / re-edit, without having to
// commit + deploy. Two tabs (composer, editor) — pick one via
// ?stage=composer|editor, defaulting to composer.
//
// The scheduled pipeline never reads these; only admin replay actions
// on a draft do. See src/shared/prompts.ts for mode handling.

import type { FC } from "hono/jsx";

import { AdminCrumbs, AdminNav } from "./admin-nav.tsx";
import { Layout } from "./layout.tsx";

export type PromptStageKey = "composer" | "editor";

export interface PromptEditorData {
  stage: PromptStageKey;
  promptText: string;
  source: "file" | "staged";
  stagedUpdatedAt: Date | null;
  liveVersion: string | null;
  flash: { kind: "ok"; msg: string } | { kind: "err"; msg: string } | null;
}

const STYLES = `
  .tabs { display: flex; gap: 4px; margin: 0 0 20px; font-family: var(--sans); font-size: 13px; }
  .tabs a { padding: 7px 14px; border: 1px solid var(--rule); background: #fff; color: var(--ink-soft); text-decoration: none; }
  .tabs a.current { background: var(--ink); color: var(--paper); border-color: var(--ink); }
  .tabs a:hover { color: var(--ink); }
  .tabs a.current:hover { color: var(--paper); }
  .stage-meta { font-family: var(--sans); font-size: 13px; color: var(--ink-soft); margin: 0 0 14px; }
  .stage-meta .staged { color: #6a5200; font-weight: 600; }
  .prompt-textarea { width: 100%; min-height: 520px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.5; padding: 12px; border: 1px solid var(--rule); background: #fff; color: var(--ink); resize: vertical; box-sizing: border-box; }
  .prompt-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 0; font-family: var(--sans); font-size: 13px; }
  .prompt-actions button, .prompt-actions a { padding: 6px 12px; border: 1px solid var(--rule); background: #fff; color: var(--ink); text-decoration: none; font: inherit; cursor: pointer; }
  .prompt-actions button:hover, .prompt-actions a:hover { border-color: var(--ink); }
  .prompt-actions button.primary { background: #2b4f2b; color: #fff; border-color: #2b4f2b; font-weight: 600; }
  .prompt-actions button.primary:hover { background: #1e3b1e; }
  .prompt-actions button.clear { color: #8a2a2a; border-color: #d4a4a4; }
  .prompt-actions button.clear:hover { background: #fbeeee; border-color: #8a2a2a; }
  .flash { padding: 10px 14px; margin: 0 0 16px; font-family: var(--sans); font-size: 14px; border: 1px solid var(--rule); }
  .flash.ok { background: #e6f3e6; border-color: #9bc79b; color: #2b4f2b; }
  .flash.err { background: #fbeeee; border-color: #d4a4a4; color: #8a2a2a; }
  .hint { background: #fff; border: 1px solid var(--rule); padding: 10px 14px; margin: 0 0 20px; font-family: var(--sans); font-size: 13px; color: var(--ink-soft); }
  .hint code { font-family: ui-monospace, Menlo, Consolas, monospace; background: var(--paper); padding: 1px 5px; border: 1px solid var(--rule); font-size: 12px; color: var(--ink); }
`;

export const AdminPrompts: FC<{ data: PromptEditorData }> = ({ data }) => (
  <Layout title={`Prompts — Blurpadurp admin`}>
    <style dangerouslySetInnerHTML={{ __html: STYLES }} />
    <AdminNav current="prompts" />
    <AdminCrumbs
      trail={[
        { label: "Prompts", href: "/admin/prompts" },
        { label: data.stage },
      ]}
    />
    <h2>Prompts</h2>
    <div class="hint">
      Staged prompts apply only to <strong>draft Re-compose / Re-edit</strong>.
      The scheduled pipeline always reads <code>docs/*-prompt.md</code>. When a
      staged edit shapes a draft you like, hit <strong>Download</strong>, paste
      into the file, commit, and <strong>Clear staged</strong>.
    </div>
    <nav class="tabs" aria-label="Prompt stage">
      <a
        href="/admin/prompts?stage=composer"
        class={data.stage === "composer" ? "current" : ""}
      >
        Composer
      </a>
      <a
        href="/admin/prompts?stage=editor"
        class={data.stage === "editor" ? "current" : ""}
      >
        Editor
      </a>
    </nav>
    {data.flash !== null ? (
      <div class={`flash ${data.flash.kind}`}>{data.flash.msg}</div>
    ) : null}
    <p class="stage-meta">
      {data.source === "staged" ? (
        <>
          <span class="staged">Staged</span> · last edit{" "}
          {data.stagedUpdatedAt !== null
            ? data.stagedUpdatedAt.toISOString().replace("T", " ").slice(0, 16) + "Z"
            : "—"}{" "}
          · live version:{" "}
          {data.liveVersion !== null ? data.liveVersion : "—"}
        </>
      ) : (
        <>
          File (<code>docs/{data.stage}-prompt.md</code>) · live version:{" "}
          {data.liveVersion !== null ? data.liveVersion : "—"}
        </>
      )}
    </p>
    <form method="post" action={`/admin/prompts/${data.stage}`}>
      <textarea
        name="prompt_md"
        class="prompt-textarea"
        spellcheck={false}
      >
        {data.promptText}
      </textarea>
      <div class="prompt-actions">
        <button type="submit" name="action" value="save" class="primary">
          Save staged
        </button>
        <button type="submit" name="action" value="download">
          Download as {data.stage}-prompt.md
        </button>
        {data.source === "staged" ? (
          <button
            type="submit"
            name="action"
            value="clear"
            class="clear"
            data-confirm="Clear the staged prompt? Re-compose/Re-edit will fall back to the committed file."
          >
            Clear staged
          </button>
        ) : null}
      </div>
    </form>
    <script src="/assets/admin-review.js" defer />
  </Layout>
);
